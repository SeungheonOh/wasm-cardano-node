{-# LANGUAGE DataKinds #-}
{-# LANGUAGE GADTs #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE RankNTypes #-}
{-# LANGUAGE TypeFamilies #-}
module Submission where

import Cardano.Api qualified as C
import Control.Concurrent.Async (race_)
import Control.Exception (throwIO)
import Control.Monad (unless, void, when)
import Control.Tracer (nullTracer)
import Data.Aeson (Value, object, (.=))
import Data.Aeson qualified as A
import Data.ByteString.Base16 qualified as Hex
import Data.ByteString.Lazy qualified as BL
import Data.IORef
import Data.List.NonEmpty (NonEmpty (..))
import Data.Map.Strict qualified as Map
import Data.Text qualified as T
import Data.Text.Encoding qualified as T
import Data.Word
import GHC.Wasm.Prim (JSString (..), fromJSString, toJSString)
import Ouroboros.Consensus.Ledger.SupportsMempool qualified as M
import Ouroboros.Consensus.Cardano.Node (protocolClientInfoCardano)
import Ouroboros.Consensus.Node.NetworkProtocolVersion
import Ouroboros.Consensus.Node.ProtocolInfo (ProtocolClientInfo (..))
import Ouroboros.Consensus.Node.Serialisation
import Ouroboros.Network.Channel (Channel (..))
import Ouroboros.Network.Driver.Limits
import Ouroboros.Network.Protocol.KeepAlive.Client qualified as KA
import Ouroboros.Network.Protocol.KeepAlive.Codec (codecKeepAlive_v2)
import Ouroboros.Network.Protocol.TxSubmission2.Client qualified as TX
import Ouroboros.Network.Protocol.TxSubmission2.Codec (codecTxSubmission2, timeLimitsTxSubmission2)
import Ouroboros.Network.Protocol.TxSubmission2.Type (NumTxIdsToAck (..), NumTxIdsToReq (..))
import Stream (Block, channel, emit, keepAliveClient, negotiate, proxy)
import Transaction (transactionJSON)

foreign export javascript "cardanoInspectTransaction"
  cardanoInspectTransaction :: Int -> JSString -> IO JSString
foreign export javascript "cardanoSubmitTransaction"
  cardanoSubmitTransaction :: Word32 -> Word64 -> Int -> JSString -> IO ()

-- The decoded value is bounded to one transaction. Neither inspection nor
-- submission creates a mempool, ledger state, or chain-sync client.
readTransaction :: Int -> JSString -> IO C.TxInMode
readTransaction era encoded = do
  let text = T.pack (fromJSString encoded)
  unless (T.length text > 0 && T.length text <= 131072) $
    throwIO (userError "Transaction CBOR must be between 1 byte and 64 KiB")
  bytes <- either (throwIO . userError) pure (Hex.decode (T.encodeUtf8 text))
  let decode :: C.IsShelleyBasedEra e => C.AsType e -> C.ShelleyBasedEra e -> IO C.TxInMode
      decode tag sbe = case C.deserialiseFromCBOR (C.AsTx tag) bytes of
        Left err -> throwIO (userError ("Cannot decode complete transaction: " ++ show err))
        Right tx -> do
          -- Preserve signed bytes, including non-canonical encodings retained
          -- by the upstream annotated codecs. Never silently rewrite a tx.
          unless (C.serialiseToCBOR tx == bytes) $
            throwIO (userError "Transaction bytes would change during decoding; refusing submission")
          pure (C.TxInMode sbe tx)
  case era of
    1 -> decode C.AsShelleyEra C.ShelleyBasedEraShelley
    2 -> decode C.AsAllegraEra C.ShelleyBasedEraAllegra
    3 -> decode C.AsMaryEra C.ShelleyBasedEraMary
    4 -> decode C.AsAlonzoEra C.ShelleyBasedEraAlonzo
    5 -> decode C.AsBabbageEra C.ShelleyBasedEraBabbage
    6 -> decode C.AsConwayEra C.ShelleyBasedEraConway
    _ -> throwIO (userError "Unsupported transaction era")

cardanoInspectTransaction :: Int -> JSString -> IO JSString
cardanoInspectTransaction era encoded = do
  input <- readTransaction era encoded
  case input of
    C.TxInMode sbe tx -> C.shelleyBasedEraConstraints sbe $ pure . toJSString . T.unpack . T.decodeUtf8 . BL.toStrict . A.encode $
      object ["transaction" .= transactionJSON tx, "keyWitnesses" .= length (C.getTxWitnesses tx), "era" .= era]
    C.TxInByronSpecial{} -> throwIO (userError "Byron submission is not supported")

cardanoSubmitTransaction :: Word32 -> Word64 -> Int -> JSString -> IO ()
cardanoSubmitTransaction magic epochSlots era encoded = do
  input <- readTransaction era encoded
  let tx = C.toConsensusGenTx input :: M.GenTx Block
      txid = M.txId tx
  version <- negotiate magic
  let config = pClientInfoCodecConfig (protocolClientInfoCardano (C.EpochSlots epochSlots))
      blockVersion = supportedNodeToNodeVersions proxy Map.! version
      codec = codecTxSubmission2
        (encodeNodeToNode @Block config blockVersion) (decodeNodeToNode @Block config blockVersion)
        (encodeNodeToNode @Block config blockVersion) (decodeNodeToNode @Block config blockVersion)
      sizes limit = ProtocolSizeLimits (const limit) (fromIntegral . BL.length)
  -- Flags implement the protocol's one-item outstanding FIFO. A peer cannot
  -- request unannounced/already acknowledged IDs, or fetch the same item twice.
  announced <- newIORef False
  outstanding <- newIORef False
  sent <- newIORef False
  afterSend <- newIORef (Nothing :: Maybe Value)
  let event kind = object ["type" .= (kind :: T.Text)]
      failPeer message = throwIO (userError ("Invalid TxSubmission2 request: " ++ message))
      idle = TX.ClientStIdle
        { TX.recvMsgRequestTxIds = \blocking (NumTxIdsToAck ack) (NumTxIdsToReq request) -> do
            pending <- readIORef outstanding
            unless (ack <= if pending then 1 else 0) (failPeer "acknowledges an ID that is not outstanding")
            let remaining = pending && ack == 0
            writeIORef outstanding remaining
            case blocking of
              TX.SingBlocking -> do
                when (remaining || request == 0) (failPeer "invalid blocking request")
                offered <- readIORef announced
                if offered then pure (TX.SendMsgDone ()) else do
                  writeIORef announced True
                  writeIORef outstanding True
                  writeIORef afterSend (Just (event "announced"))
                  pure (TX.SendMsgReplyTxIds (TX.BlockingReply ((txid, M.txWireSize tx) :| [])) idle)
              TX.SingNonBlocking -> do
                unless (remaining && (ack > 0 || request > 0)) (failPeer "invalid non-blocking request")
                pure (TX.SendMsgReplyTxIds (TX.NonBlockingReply []) idle)
        , TX.recvMsgRequestTxs = \ids -> do
            pending <- readIORef outstanding
            delivered <- readIORef sent
            unless (pending && not delivered && ids == [txid]) (failPeer "unknown or repeated transaction ID")
            writeIORef sent True
            writeIORef afterSend (Just (event "sent"))
            pure (TX.SendMsgReplyTxs [tx] idle)
        }
      base = channel 4
      submissionChannel = base { send = \bytes -> do
        send base bytes
        notification <- atomicModifyIORef' afterSend (\value -> (Nothing, value))
        maybe (pure ()) emit notification
        }
      submit = do
        void $ runPeerWithLimits nullTracer codec (sizes 65536)
          -- StIdle intentionally has no protocol timeout. Real nodes normally
          -- wait 60 seconds before their first request. The app owns the
          -- cancellable overall deadline; KeepAlive still detects dead peers.
          timeLimitsTxSubmission2 submissionChannel
          (TX.txSubmissionClientPeer (TX.TxSubmissionClient (pure idle)))
        delivered <- readIORef sent
        emit (object ["type" .= ("finished" :: T.Text), "sent" .= delivered])
      keep = void $ runPeerWithLimits nullTracer codecKeepAlive_v2 (sizes 128)
        (ProtocolTimeLimits (const (Just 20))) (channel 8) (KA.keepAliveClientPeer keepAliveClient)
  race_ keep submit
