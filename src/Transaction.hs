{-# LANGUAGE GADTs #-}
{-# LANGUAGE OverloadedStrings #-}
module Transaction (transactionJSON) where

import Cardano.Api qualified as C
import Data.Aeson (Value (Null), object, (.=))
import Data.Aeson qualified as A
import Data.ByteString qualified as BS
import Data.ByteString.Base16 qualified as Hex
import Data.ByteString.Lazy qualified as BL
import Data.Text qualified as T
import Data.Text.Encoding qualified as T
import GHC.Exts (toList)

-- Decimal strings preserve ledger integers across the JSON/JavaScript boundary.
-- Inputs remain references: this view never resolves a UTxO or validates a tx.
transactionJSON :: C.IsShelleyBasedEra era => C.Tx era -> Value
transactionJSON tx = object
  [ "id" .= C.serialiseToRawBytesHexText (C.getTxId body)
  , "cborHex" .= hex bytes
  , "sizeBytes" .= BS.length bytes
  , "inputs" .= map (inputJSON . fst) (C.txIns content)
  , "outputs" .= map outputJSON (C.txOuts content)
  , "feeLovelace" .= case C.txFee content of C.TxFeeExplicit _ coin -> coinText coin
  , "outputLovelace" .= coinText (mconcat [C.selectLovelace (C.txOutValueToValue value) | C.TxOut _ value _ _ <- C.txOuts content])
  , "mint" .= assetsJSON (C.txMintValueToValue (C.txMintValue content))
  , "validity" .= object
      [ "fromSlot" .= case C.txValidityLowerBound content of
          C.TxValidityNoLowerBound -> Nothing
          C.TxValidityLowerBound _ (C.SlotNo slot) -> Just (show slot)
      , "untilSlot" .= case C.txValidityUpperBound content of
          C.TxValidityUpperBound _ slot -> fmap (\(C.SlotNo n) -> show n) slot
      ]
  , "scriptValidity" .= case C.txScriptValidity content of
      C.TxScriptValidityNone -> ("not-applicable" :: T.Text)
      C.TxScriptValidity _ C.ScriptValid -> "valid"
      C.TxScriptValidity _ C.ScriptInvalid -> "invalid"
  , "metadataJson" .= case C.txMetadata content of
      C.TxMetadataNone -> Nothing
      C.TxMetadataInEra _ metadata -> Just (jsonText (C.metadataToJson C.TxMetadataJsonDetailedSchema metadata))
  , "requiredSigners" .= case C.txExtraKeyWits content of
      C.TxExtraKeyWitnessesNone -> []
      C.TxExtraKeyWitnesses _ hashes -> map C.serialiseToRawBytesHexText hashes
  , "withdrawals" .= case C.txWithdrawals content of
      C.TxWithdrawalsNone -> []
      C.TxWithdrawals _ withdrawals -> [object ["address" .= C.serialiseAddress address, "lovelace" .= coinText coin] | (address, coin, _) <- withdrawals]
  , "collateralInputs" .= case C.txInsCollateral content of
      C.TxInsCollateralNone -> []
      C.TxInsCollateral _ inputs -> map inputJSON inputs
  , "referenceInputs" .= case C.txInsReference content of
      C.TxInsReferenceNone -> []
      C.TxInsReference _ inputs _ -> map inputJSON inputs
  , "totalCollateralLovelace" .= case C.txTotalCollateral content of
      C.TxTotalCollateralNone -> Nothing
      C.TxTotalCollateral _ coin -> Just (coinText coin)
  , "collateralReturn" .= case C.txReturnCollateral content of
      C.TxReturnCollateralNone -> Null
      C.TxReturnCollateral _ output -> outputJSON output
  ]
 where
  body = C.getTxBody tx
  content = C.getTxBodyContent body
  bytes = C.serialiseToCBOR tx

coinText :: C.Coin -> String
coinText (C.Coin n) = show n

hex :: BS.ByteString -> T.Text
hex = T.decodeUtf8 . Hex.encode

-- Keep arbitrary metadata/datum integers as JSON text, without JS rounding.
jsonText :: Value -> T.Text
jsonText = T.decodeUtf8 . BL.toStrict . A.encode

inputJSON :: C.TxIn -> Value
inputJSON (C.TxIn txid (C.TxIx index)) = object
  [ "txId" .= C.serialiseToRawBytesHexText txid, "index" .= index ]

assetsJSON :: C.Value -> [Value]
assetsJSON value =
  [ object ["policyId" .= C.serialiseToRawBytesHexText policy,
            "nameHex" .= hex name, "name" .= either (const Nothing) Just (T.decodeUtf8' name),
            "quantity" .= show quantity]
  | (C.AssetId policy assetName, C.Quantity quantity) <- toList value
  , let name = C.serialiseToRawBytes assetName
  ]

outputJSON :: C.IsCardanoEra era => C.TxOut ctx era -> Value
outputJSON (C.TxOut address amount datum script) = object
  [ "address" .= C.serialiseAddress address
  , "lovelace" .= coinText (C.selectLovelace value)
  , "assets" .= assetsJSON value
  , "datum" .= datumJSON datum
  , "referenceScriptHash" .= case script of
      C.ReferenceScriptNone -> Nothing
      C.ReferenceScript _ (C.ScriptInAnyLang _ s) -> Just (C.serialiseToRawBytesHexText (C.hashScript s))
  ]
 where value = C.txOutValueToValue amount

datumJSON :: C.TxOutDatum ctx era -> Value
datumJSON C.TxOutDatumNone = Null
datumJSON (C.TxOutDatumHash _ hashValue) = object
  ["type" .= ("hash" :: T.Text), "hash" .= C.serialiseToRawBytesHexText hashValue]
datumJSON (C.TxOutSupplementalDatum _ value) = scriptDataJSON "supplemental" value
datumJSON (C.TxOutDatumInline _ value) = scriptDataJSON "inline" value

scriptDataJSON :: T.Text -> C.HashableScriptData -> Value
scriptDataJSON kind value = object
  [ "type" .= kind, "hash" .= C.serialiseToRawBytesHexText (C.hashScriptDataBytes value)
  , "json" .= jsonText (C.scriptDataToJson C.ScriptDataJsonDetailedSchema value)
  ]
