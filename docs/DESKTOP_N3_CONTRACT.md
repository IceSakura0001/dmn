# Desktop-N3 maintenance contract

Diagnostics expose bounded queue, turn, dead-letter, proof-class, budget and token metadata only. Raw SDK prompts, assistant log bodies, memory and credentials are excluded. The business bridge does not gain recovery or file operations.

The separate owner-authenticated maintenance route requires a distinct header and an explicit typed operation. Reconcile/drop/quarantine are bound by the Host to desktop-user, serialized against active scheduling and audited by existing transactions. Drop requires exact turnId confirmation and a nonempty reason. Proof inspection never authorizes replay; busy or unproved Runtime roots remain fenced.

Backup, verify and restore use a one-shot maintenance worker after the owning service stops and its exit is confirmed. A borrowed service cannot be stopped for maintenance. Renderer inputs contain UUID backup IDs and instance confirmation only; paths derive from trusted instance configuration. Backups reside beside the database in a fixed backup directory. Restore to an existing original location preserves the old complete pair in a rollback directory, holds the maintenance barrier and leaves restore-incomplete on interrupted publication. No recursive deletion or automatic inference follows maintenance.

No schema migration. Tests cover busy refusal, forged identity/path rejection, drop audit rollback, stopped backup/verify/restore, retained prior data and interrupted restore fencing. Real Desktop and real SDK evidence are reported separately.

Explicit stale-owner retirement is a separate maintenance action. It requires the exact instance ID, old PID and a reason; proves ESRCH, checks all client registrations and Runtime markers, archives only matching owner/discovery metadata, and writes desktop-user audit. Any live/ambiguous process, Runtime lock or audit failure retains the barrier. Unknown turns and budgets are not changed or replayed. It is never an automatic restart step.
