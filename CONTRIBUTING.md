# Contributing to TryVoice

Thanks for your interest in contributing! TryVoice is in early development and we welcome feedback, bug reports, and code contributions.

## Reporting Issues

Open a [GitHub Issue](https://github.com/AaronZ021/tryvoice-oss/issues) with:

- What you expected vs. what happened
- Steps to reproduce
- Your OS, browser, and Python version
- Relevant logs from `~/.tryvoice/logs/server.log` or `client.log`

## Development Setup

```bash
git clone https://github.com/AaronZ021/tryvoice-oss.git
cd tryvoice
bash scripts/setup.sh
source .venv/bin/activate
```

### Running checks

```bash
# Linting
ruff check apps/host-runtime/
ruff format --check apps/host-runtime/

# Frontend type check
cd apps/client-web/frontend && npx tsc --noEmit
```

### Code style

- **Python**: [ruff](https://docs.astral.sh/ruff/) for formatting and linting
- **TypeScript**: ESLint + TypeScript strict mode
- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, etc.

## Pull Requests

1. Fork the repo and create a feature branch
2. Make your changes with tests where applicable
3. Run `ruff check apps/host-runtime/` and `cd apps/client-web/frontend && npx tsc --noEmit` before submitting
4. Open a PR with a clear description of what and why

## Writing an Adapter

One of the most impactful contributions is adding support for a new AI agent. See the [Building an Adapter](README.md#building-an-adapter) section in the README for the protocol reference.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
