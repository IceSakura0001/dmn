# Desktop-N4 installation and configuration contract

The Windows release is a source ZIP with a locked dependency graph and an explicit PowerShell installer. It links the unpacked plugin through the installed official Desktop CLI; it does not patch Desktop core or bypass incompatible plugins. Supported baseline: Desktop/SDK 0.2.1-rc.3, Node >=24.14, protocol 1, schema 7. Installation requires Node/npm and registry access. Installation/upgrade/removal require a normal Desktop exit before changes; no forced SDK termination.

Installer backs up profile manifests/patches locally, preserves all other bundles, and retains business data on uninstall. Upgrade keeps the same configured absolute database/Runtime pair. A clean default instance lives under the user's DSH home, outside the unpacked release. Rollback retains the old release and paired backups; future or incompatible schema is refused.

An official settings.section contribution and in-panel setup form expose versioned nonsecret settings: database, log directory, provider credential reference and two supported DeepSeek model choices. Existing instances keep their immutable routes/root IDs; configuration must not silently rebind an existing node. Values use optimistic revision checks and atomic replacement with retained previous settings. Actual keys go only through ctx.credentials.set/resolve, never into ordinary settings, logs, release archives or Git. Read-only checks resolve credential presence and service state; model tests require explicit bounded topic/input actions.

No new provider, background autonomy or model tools. A release archive is created only from a clean committed tree, excludes ignored data and includes reproducible version/integrity metadata. Native update and uninstall are verified separately from npm dependency installation and simulated tests.

All mutating business/maintenance requests carry a Host-checked instance identity. Pending requests are stored per instance. A configuration switch cannot reinterpret an old pending start/send as authorization for another database. Reads can discover the current instance without an old identity blocking reconnect.
