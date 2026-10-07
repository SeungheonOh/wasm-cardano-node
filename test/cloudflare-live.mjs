// Read-only dashboard regression through the public Cloudflare deployment.
process.env.CARDANO_SITE ??= 'https://cardano.isotopy.xyz';
process.env.CHROMIUM_PATH ??= '/snap/bin/chromium';
process.env.CHECK_DASHBOARD ??= '1';
process.env.REQUIRE_TX = '1';
process.env.CHECK_SUBMISSION ??= '1';
process.env.EVIDENCE_NAME ??= 'cloudflare-dashboard';
await import('./browser.mjs');
