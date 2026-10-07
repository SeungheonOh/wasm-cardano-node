{-# LANGUAGE DataKinds #-}
{-# LANGUAGE GADTs #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TypeFamilies #-}
module Stream where

import Cardano.Api qualified as C
import Cardano.Protocol.Crypto (StandardCrypto)
import Cardano.Network.NodeToNode.Version
import Control.Concurrent.MVar
import Control.Concurrent.Async (race_)
import Control.Exception (evaluate, throwIO)
import Control.Monad (unless, void)
import Control.Tracer (nullTracer)
import Data.Aeson (Value, object, (.=))
import Data.Aeson qualified as A
import Data.ByteString.Base16 qualified as Hex
import Data.ByteString.Char8 qualified as BS
import Data.ByteString.Lazy qualified as BL
import Data.IORef
import Data.Map.Strict qualified as Map
import Data.Text qualified as T
import Data.Text.Encoding qualified as T
import Data.Word
import GHC.Wasm.Prim (JSString (..), JSVal, fromJSString, toJSString)
import GHC.Clock (getMonotonicTimeNSec)
import Ouroboros.Consensus.Block
import Ouroboros.Consensus.Cardano.Block (CardanoBlock)
import Ouroboros.Consensus.Cardano.Node (protocolClientInfoCardano)
import Ouroboros.Consensus.Node.NetworkProtocolVersion
import Ouroboros.Consensus.Node.ProtocolInfo (ProtocolClientInfo (..))
import Ouroboros.Consensus.Node.Serialisation
import Ouroboros.Network.Block qualified as N
import Ouroboros.Network.Channel (Channel (..))
import Ouroboros.Network.Driver.Limits
import Ouroboros.Network.Magic (NetworkMagic (..))
import Ouroboros.Network.PeerSelection.PeerSharing (PeerSharing (..))
import Ouroboros.Network.Protocol.BlockFetch.Client qualified as BF
import Ouroboros.Network.Protocol.BlockFetch.Codec (codecBlockFetch)
import Ouroboros.Network.Protocol.BlockFetch.Type (ChainRange (..))
import Ouroboros.Network.Protocol.ChainSync.Client qualified as CS
import Ouroboros.Network.Protocol.ChainSync.Codec (codecChainSync)
import Ouroboros.Network.Protocol.Handshake.Client (handshakeClientPeer)
import Ouroboros.Network.Protocol.Handshake.Codec
import Ouroboros.Network.Protocol.Handshake.Type (HandshakeResult (..))
import Ouroboros.Network.Protocol.Handshake.Version
import Ouroboros.Network.Protocol.KeepAlive.Client qualified as KA
import Ouroboros.Network.Protocol.KeepAlive.Codec (codecKeepAlive_v2)
import Ouroboros.Network.Protocol.KeepAlive.Type (Cookie (..))
import VersionData (versionDataCodec)
import Transaction (transactionJSON)

-- The host supplies only byte channels and an event sink. Every protocol message
-- is produced/consumed by the original Ouroboros typed clients and codecs.
foreign import javascript safe "globalThis.cardanoTransport.receive($1)"
  jsReceive :: Int -> IO JSVal
foreign import javascript safe "globalThis.cardanoTransport.send($1, $2)"
  jsSend :: Int -> JSString -> IO ()
foreign import javascript safe "globalThis.cardanoTransport.emit($1)"
  jsEmit :: JSString -> IO ()
foreign import javascript safe "globalThis.cardanoTransport.sleep($1)"
  jsSleep :: Int -> IO ()
foreign export javascript "cardanoStream"
  cardanoStream :: Word32 -> Word64 -> Bool -> IO ()

type Block = CardanoBlock StandardCrypto

proxy :: Proxy Block
proxy = Proxy

emit :: Value -> IO ()
emit v = evaluate =<< jsEmit (toJSString (T.unpack (T.decodeUtf8 (BL.toStrict (A.encode v)))))

channel :: Int -> Channel IO BL.ByteString
channel protocol = Channel
  { send = \bytes -> evaluate =<< jsSend protocol (toJSString (BS.unpack (Hex.encode (BL.toStrict bytes))))
  , recv = do
      value <- evaluate =<< jsReceive protocol
      let raw = BS.pack (fromJSString (JSString value))
      if BS.null raw then pure Nothing
        else Just . BL.fromStrict <$> either (throwIO . userError) pure (Hex.decode raw)
  }

pointJSON :: Point Block -> Value
pointJSON N.GenesisPoint = object ["origin" .= True]
pointJSON (N.BlockPoint (SlotNo slot) hash) =
  object ["slot" .= show slot, "hash" .= T.decodeUtf8 (Hex.encode (toRawHash proxy hash))]

tipJSON :: N.Tip Block -> Value
tipJSON N.TipGenesis = object ["origin" .= True]
tipJSON (N.Tip slot hash (BlockNo number)) =
  object ["point" .= pointJSON (N.BlockPoint slot hash), "blockNo" .= show number]

-- Zero history, UTxO, ledger state or ChainDB. A point and a single in-flight
-- block are sufficient; waiting for the fetch before RequestNext preserves the
-- event ordering across rollbacks and puts backpressure on the peer.
chainClient :: Bool -> MVar (Point Block, MVar ()) -> CS.ChainSyncClient (Header Block) (Point Block) (N.Tip Block) IO ()
chainClient bodies requests = CS.ChainSyncClient (pure (CS.SendMsgFindIntersect [] discover))
 where
  discover = CS.ClientStIntersect
    { CS.recvMsgIntersectFound = \_ tip -> seek 0 tip
    , CS.recvMsgIntersectNotFound = seek 0
    }
  seek :: Int -> N.Tip Block -> CS.ChainSyncClient (Header Block) (Point Block) (N.Tip Block) IO ()
  seek retries tip = CS.ChainSyncClient $ do
    unless (retries < 10) (throwIO (userError "Peer tip changed during ten intersection attempts"))
    pure $ CS.SendMsgFindIntersect [N.getTipPoint tip] CS.ClientStIntersect
      { CS.recvMsgIntersectFound = \point currentTip -> CS.ChainSyncClient $ do
          emit (object ["type" .= ("intersect" :: T.Text), "point" .= pointJSON point, "tip" .= tipJSON currentTip])
          pure next
      , CS.recvMsgIntersectNotFound = seek (retries + 1)
      }
  next = CS.SendMsgRequestNext
    (emit (object ["type" .= ("await" :: T.Text)])) CS.ClientStNext
      { CS.recvMsgRollForward = \header tip -> CS.ChainSyncClient $ do
          let point = headerPoint header
              BlockNo number = N.blockNo header
          emit (object ["type" .= ("rollForward" :: T.Text), "point" .= pointJSON point,
                        "blockNo" .= show number, "tip" .= tipJSON tip])
          if bodies then do
            done <- newEmptyMVar
            putMVar requests (point, done)
            takeMVar done
          else pure ()
          pure next
      , CS.recvMsgRollBackward = \point tip -> CS.ChainSyncClient $ do
          emit (object ["type" .= ("rollBackward" :: T.Text), "point" .= pointJSON point, "tip" .= tipJSON tip])
          pure next
      }

blockClient :: MVar (Point Block, MVar ()) -> BF.BlockFetchClient Block (Point Block) IO ()
blockClient requests = client
 where
  client = BF.BlockFetchClient $ do
    (point, done) <- takeMVar requests
    count <- newIORef (0 :: Int)
    let receiver = BF.BlockFetchReceiver
          { BF.handleBlock = \block -> do
              n <- readIORef count
              -- Check the requested identity, not the ledger or consensus rules.
              unless (n == 0 && N.blockPoint block == point)
                (throwIO (userError "BlockFetch returned an extra or different block"))
              writeIORef count 1
              case C.fromConsensusBlock block of
                C.BlockInMode era apiBlock -> C.inEonForEra
                  (throwIO (userError "Transaction events support Shelley and later blocks"))
                  (\sbe -> C.shelleyBasedEraConstraints sbe $ do
                  let txs = C.getBlockTxs apiBlock
                  emit (object ["type" .= ("block" :: T.Text), "point" .= pointJSON point,
                                "era" .= show era, "transactions" .= map transactionJSON txs])) era
              pure receiver
          , BF.handleBatchDone = do
              n <- readIORef count
              unless (n == 1) (throwIO (userError "BlockFetch returned an empty batch"))
              putMVar done ()
          }
    pure $ BF.SendMsgRequestRange (ChainRange point point) BF.BlockFetchResponse
      { BF.handleStartBatch = pure receiver
      , BF.handleNoBlocks = do
          emit (object ["type" .= ("blockUnavailable" :: T.Text), "point" .= pointJSON point])
          putMVar done ()
      } client

keepAliveClient :: KA.KeepAliveClient IO ()
keepAliveClient = KA.KeepAliveClient (loop 0)
 where
  loop cookie = do
    started <- getMonotonicTimeNSec
    pure (KA.SendMsgKeepAlive (Cookie cookie) $ do
      finished <- getMonotonicTimeNSec
      emit (object ["type" .= ("keepAlive" :: T.Text),
                    "roundTripMs" .= (fromIntegral (finished - started) / 1000000 :: Double)])
      evaluate =<< jsSleep 10000
      loop (cookie + 1))

cardanoStream :: Word32 -> Word64 -> Bool -> IO ()
cardanoStream magic epochSlots bodies = do
  version <- negotiate magic
  stream version epochSlots bodies

negotiate :: Word32 -> IO NodeToNodeVersion
negotiate magic = do
  let versionData = NodeToNodeVersionData (NetworkMagic magic) InitiatorOnlyDiffusionMode PeerSharingDisabled False
      versions = Versions (Map.map (const (Version (const ()) versionData)) (supportedNodeToNodeVersions proxy))
  (negotiation, _) <- runPeerWithLimits nullTracer (codecHandshake nodeToNodeVersionCodec)
    byteLimitsHandshake (ProtocolTimeLimits (const (Just 10))) (channel 0)
    (handshakeClientPeer (cborTermVersionDataCodec versionDataCodec) acceptableVersion versions)
  version <- case negotiation of
    Right (HandshakeNegotiationResult () v _) -> pure v
    Left err -> throwIO (userError ("Handshake failed: " ++ show err))
    Right HandshakeQueryResult{} -> throwIO (userError "Unexpected handshake query result")
  emit (object ["type" .= ("connected" :: T.Text), "networkMagic" .= magic, "version" .= show version])
  pure version

stream :: NodeToNodeVersion -> Word64 -> Bool -> IO ()
stream version epochSlots bodies = do
  let config = pClientInfoCodecConfig (protocolClientInfoCardano (C.EpochSlots epochSlots))
      blockVersion = supportedNodeToNodeVersions proxy Map.! version
      csCodec = codecChainSync
        (encodeNodeToNode @Block config blockVersion) (decodeNodeToNode @Block config blockVersion)
        (N.encodePoint (encodeRawHash proxy)) (N.decodePoint (decodeRawHash proxy))
        (N.encodeTip (encodeRawHash proxy)) (N.decodeTip (decodeRawHash proxy))
      bfCodec = codecBlockFetch
        (encodeNodeToNode @Block config blockVersion) (decodeNodeToNode @Block config blockVersion)
        (N.encodePoint (encodeRawHash proxy)) (N.decodePoint (decodeRawHash proxy))
      sizes limit = ProtocolSizeLimits (const limit) (fromIntegral . BL.length)
  requests <- newEmptyMVar
  let sync = void $ runPeerWithLimits nullTracer csCodec (sizes 262144)
        (ProtocolTimeLimits (const Nothing)) (channel 2) (CS.chainSyncClientPeer (chainClient bodies requests))
      fetch = void $ runPeerWithLimits nullTracer bfCodec (sizes 2097152)
        (ProtocolTimeLimits (const (Just 30))) (channel 3) (BF.blockFetchClientPeer (blockClient requests))
      keep = void $ runPeerWithLimits nullTracer codecKeepAlive_v2 (sizes 128)
        (ProtocolTimeLimits (const (Just 20))) (channel 8) (KA.keepAliveClientPeer keepAliveClient)
  race_ keep (if bodies then race_ sync fetch else sync)
