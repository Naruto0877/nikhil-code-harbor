# Security and data handling

This release is intended for a single user on a local machine. Numeric loopback binding is enforced. Every API endpoint except the minimal health check requires a separate harbor token, and browser cross-origin requests are rejected. Do not place an unauthenticated public reverse proxy in front of the listener; public/multi-user deployment is not supported.

Provider API keys are read from environment variables at request time. They are not written to the configuration, usage file, or logs. Inference requests follow configured endpoints only, HTTPS is required for remote endpoints, and redirects are rejected. No OAuth tokens, session cookies, certificate installations, or upstream app credentials are harvested.

The browser shell is publicly readable on the loopback listener. Its script keeps the token and conversation in page memory. Linked gateways receive the conversation and control billing, retention and any downstream routing. Their displayed evidence is upstream-managed.

The generated gateway token and aggregate usage file are stored with owner-only file permissions. This is filesystem access control, not encryption at rest. Protect the local user account, environment, state directory, and backups. The harbor never puts provider keys into Git or provides a key-export endpoint.

OpenRouter routing checks current public model prices, restricts model names to free variants, forbids client routing/add-on overrides, adds zero-price routing bounds, and disables provider data collection. This is evidence about a service interface, not a guarantee of upstream availability or unchanged future billing. The cached evidence lifetime is explicit. Failed or expired verification blocks use.

Operator-declared free tiers are separate and disabled by default. Their account policy must be checked by the operator; a declaration is not independently verified by the software. Local inference can have compute costs and may itself proxy another service. Neither mode is assigned a fictitious monthly allowance.

Prompts, code, images, tool outputs, and other supplied request content are forwarded to the configured hosted provider when one is selected. Input is not automatically redacted. Fallback can forward that conversation to another explicitly configured provider. Only aggregate counters are stored locally. Provider-side policies still govern what the upstream service retains.

Non-success upstream response bodies and transport error details are not exposed. Successful response bodies and event streams are forwarded as provider output, including error events embedded in a successful HTTP stream. Clients must treat all model output as untrusted and enforce their own tool-execution permissions.

The initial release has automated fixture tests and a public catalog connectivity check. It has not received an independent security audit or authenticated end-to-end model/client verification. Report a suspected vulnerability privately to the repository owner before posting credentials, exploit details, or private conversation content in a public issue.
