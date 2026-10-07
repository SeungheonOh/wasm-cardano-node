# WASM build infrastructure

The dependency manifest, preparation recipe, project settings, and portability
patches are maintained in this repository. A build reads only this checkout and
its project-owned cache; no sibling checkout, package database, or external
project cache is discovered. The project LICENSE contains the Apache-2.0 license
text that applies to this build infrastructure and the application sources.

The compiler installer is fetched directly from the upstream ghc-wasm-meta
repository at the revision in `toolchain.json`. Its pinned bindists provide the
compiler, WASI SDK, Cabal, and runtime tools. No on-chain Plinth compiler is built
or required: this app decodes and streams data using the Cardano libraries.

| Area | Change and reason |
| --- | --- |
| Plutus budgets | `SatInt` stores `Int64`. Arithmetic saturates at 64-bit bounds on WASM32. Ledger execution budgets exceed the signed 32-bit range. |
| Plutus builtins | Integer denotations that were native `Int` use `Int64`. Byte-array indexing narrows only after range checks or saturation. Bit operations preserve 64-bit indices and shift/rotate amounts. |
| Plutus examples | Example builtin denotations use explicit `Int64`/`Word64`, matching the native 64-bit meaning. No failing placeholder builtin instances are added. |
| Cryptography | Link portable sodium, blst, and secp256k1 C packages. Correct C/Haskell return signatures for Curve25519, Curve448, Ed25519, wallet initialization, and VRF conversion functions. WebAssembly validates function signatures strictly. |
| VRF | A four-limb C scalar buffer uses `unsigned long long`, retaining the required 32-byte size on WASM32. Certificate ordering compares serialized proof bytes as required by the selected crypto-class API. |
| Foundation | Use WASI memory-map emulation, little-endian configuration, WASI secure randomness, and clock wrappers. Native socket bindings are excluded from this package's WASM build. |
| Other portable dependencies | Use pinned WASM-compatible basement, network, cborg, ram, memory, cryptonite, and double-conversion sources/patches. Disable Argon2 native threading in crypton. |
| CBOR compatibility | Restore the `decodeWithByteSpan` tuple interface expected by the selected Cardano packages, using the decoder's byte offsets. |
| Build graph | Exclude native database tools and unrelated test/executable components from the patched API/consensus package descriptions. Retain the library graph needed by the stream client and block/transaction codecs. |
| GHC compatibility | Add required KES size constraints and match the heap-size C helper's 64-bit return type. |
| API compatibility | Use the crypto package's public BLS proof-of-possession context and disambiguate the ledger's `ByteSpan` type from the newer CBOR export. |

The local Cabal executable uses the original Ouroboros clients/codecs and
Cardano API. The patch set makes the necessary library graph portable to WASM32;
it does not turn on a node kernel, ChainDB, ledger validation, or script execution.
The small `src/VersionData.hs` adapter separately fixes the handshake's uint32
network-magic check on WASM32.
