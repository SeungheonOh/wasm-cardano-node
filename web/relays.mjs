// Convenience presets only. The bridge accepts arbitrary TCP relay URLs.
export const RELAYS = Object.freeze([
  { host: 'backbone.cardano.iog.io', port: 3001, networkMagic: 764824073 },
  { host: 'backbone.mainnet.cardanofoundation.org', port: 3001, networkMagic: 764824073 },
  { host: 'preview-node.play.dev.cardano.org', port: 3001, networkMagic: 2 },
  { host: 'preprod-node.play.dev.cardano.org', port: 3001, networkMagic: 1 },
]);
