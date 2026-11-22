# Contributing to Nikhil Code Harbor

Thank you for your interest in contributing to **Nikhil Code Harbor**! We welcome community contributions, bug reports, feature requests, and documentation improvements to make local AI coding gateways faster, more reliable, and developer-friendly.

---

## Code of Conduct

We are committed to providing a welcoming, inclusive, and harassment-free environment for everyone. Please treat all maintainers, contributors, and users with respect and professional courtesy.

---

## How to Contribute

### 1. Reporting Bugs
- Check the [existing issues](https://github.com/Naruto0877/nikhil-code-harbor/issues) to ensure the bug hasn't already been reported.
- If not reported, open a new issue describing:
  - The exact command or API call that triggered the problem.
  - Expected vs. actual behavior.
  - Node.js version (`node -v`) and operating system.
  - Minimal reproducible example (ensure API keys or credentials are not included in logs).

### 2. Suggesting Enhancements
- Open a GitHub Issue explaining the proposed feature, the use case, and how it benefits developers working with AI coding tools (such as Claude Code, VS Code, Cursor, or CLI pipelines).
- Discuss design details before submitting large architectural changes.

### 3. Pull Request Guidelines
1. Fork the repository and create a branch from `main` (`git checkout -b feature/my-feature`).
2. Adhere to the zero-external-dependency rule: core server and CLI logic utilize native Node.js APIs (`node:http`, `node:fs`, `node:crypto`, `node:events`).
3. Ensure static syntax and integrity checks pass:
   ```bash
   npm run check
   ```
4. Write test coverage for new endpoints, routing rules, or protocol behaviors in `test/`.
5. Keep commits atomic and clearly described.
6. Open a Pull Request referencing relevant issues.

---

## Security Disclosures

If you discover a potential security vulnerability (e.g. boundary violations, credential leakage, or origin bypass), please refer to our [Security Policy](SECURITY.md) and disclose it privately to maintainers rather than posting publicly.
