{-# LANGUAGE LambdaCase #-}
{-# LANGUAGE OverloadedStrings #-}
-- Adapted from cardano-diffusion-1.0.0.0, Cardano.Network.NodeToNode.Version
-- (Apache-2.0, Intersect). Its TInt guard compares an Int with 0xffffffff:
-- on wasm32 that literal is -1 and EVERY network magic fails decoding.
-- Keep the upstream data type and wire layout, but range-check using Integer.
module VersionData (versionDataCodec) where

import Cardano.Network.NodeToNode.Version
import Codec.CBOR.Term qualified as CBOR
import Data.Text (Text)
import Data.Word (Word32)
import Ouroboros.Network.CodecCBORTerm (CodecCBORTerm (..))
import Ouroboros.Network.Magic (NetworkMagic (..))
import Ouroboros.Network.PeerSelection.PeerSharing (PeerSharing (..))

versionDataCodec :: NodeToNodeVersion -> CodecCBORTerm Text NodeToNodeVersionData
versionDataCodec _ = CodecCBORTerm
  { encodeTerm = \v -> CBOR.TList
      [ CBOR.TInteger (toInteger (unNetworkMagic (networkMagic v)))
      , CBOR.TBool (diffusionMode v == InitiatorOnlyDiffusionMode)
      , CBOR.TInt (if peerSharing v == PeerSharingDisabled then 0 else 1)
      , CBOR.TBool (query v)
      ]
  , decodeTerm = \case
      CBOR.TList [rawMagic, CBOR.TBool initiatorOnly, CBOR.TInt sharing, CBOR.TBool isQuery] -> do
        magic <- case rawMagic of
          CBOR.TInt n -> Right (toInteger n)
          CBOR.TInteger n -> Right n
          _ -> Left "networkMagic must be an integer"
        if magic < 0 || magic > toInteger (maxBound :: Word32)
          then Left "networkMagic is outside uint32"
          else do
            peers <- case sharing of
              0 -> Right PeerSharingDisabled
              1 -> Right PeerSharingEnabled
              _ -> Left "peerSharing is outside its enum"
            pure NodeToNodeVersionData
              { networkMagic = NetworkMagic (fromInteger magic)
              , diffusionMode = if initiatorOnly then InitiatorOnlyDiffusionMode else InitiatorAndResponderDiffusionMode
              , peerSharing = peers
              , query = isQuery
              }
      _ -> Left "Invalid node-to-node version data"
  }
