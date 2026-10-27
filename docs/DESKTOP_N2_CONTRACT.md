# Desktop-N2 native operator contract

The native main panel reads state on mount and uses an owner-authenticated Host Connection route. POST /api/dmn-native/operate accepts only {method,params}, a fixed custom operator header, and an explicit allowlist of business operations. Paths, credentials, sender identities and raw SDK calls are not parameters. Existing strict OperatorService schemas remain authoritative.

Users choose either fixed node A or B as the recipient. Creating a direct topic reserves a visible finite policy without invoking a model; a discussion start explicitly authorizes the selected start node. Every start/send writes a UUID idempotency key before submission. Unknown/lost replies retain the exact request for explicit retry, including across panel remounts. Reads and polling never resubmit writes. Accepted means queued, not completed.

Timeline entries use host-provided sender/recipient, replyTo and turnId. Replies, silent/decline, retry, suppressed, failed and unknown have distinct text states. Bodies render as React text, never HTML. Pagination is topic-bound and deduplicated. Pause/resume/close use existing epoch fencing and immutable quotas. No schema migration or new model tools.

Tests precede native interaction: bridge allowlist/body/origin/header bounds; simulated browser recipient, duplicate clicks, remount/lost response, pagination and script text; service tests ensure target-only calls and fixed roots. Real Desktop interaction is recorded separately from simulations and paid inference.

## Paid acceptance budget (fixed before any native model request)

N2 plus N5 use at most 6 real SDK activities total on the isolated native-dev instance: two targeted A/B inputs, up to two further fixed-root continuity inputs, and a two-turn discussion. Every activity reserves at most 32768 input tokens, 768 output tokens, 0.25 project estimated-cost units and 60 seconds. Aggregate ceiling: 196608 input, 4608 output, 1.5 estimated-cost units, observation <= 15 minutes. Requests do not enlarge quotas on failure; unknown output is inspected rather than resubmitted. This is an acceptance budget, not a claim about billing currency or actual provider cost.
