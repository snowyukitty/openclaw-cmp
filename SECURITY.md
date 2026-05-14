# Security Policy

## Reporting

If you find a security issue in `openclaw-cmp`, please do not open a public issue with sensitive details.

Instead, contact the maintainer privately first and include:
- affected version or commit
- reproduction steps
- impact
- any relevant logs with secrets removed

## Sensitive Data

This project interacts with browser-backed AI sessions and local auth/runtime helpers.

Please avoid sharing:
- session cookies
- auth tokens
- raw browser storage
- local OpenClaw credentials
- screenshots that expose account or token data
