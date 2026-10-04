# Contributing to Memoia

<!-- Modified for Memoia: maintained repository, runtime, and contribution workflow. -->

Memoia is independently maintained from Memobase under Apache-2.0. Preserve upstream
attribution and the compatibility boundaries in the [release guide](./docs/guide/memoia-release.md).

## Table of Contents
- [Development Setup](#development-setup)
  - [Server Development](#server-development)
  - [Client Development](#client-development)
- [Development Workflow](#development-workflow)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [PR or Issue?](#pr-or-issue?)
- [Communication](#communication)

## Development Setup

### Server Development

#### Prerequisites
- Python 3.12 and uv
- Docker
- Git

#### Setting Up the Environment
1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/your-username/memoia.git
   cd memoia
   ```

3. Set up the virtual environment:
   ```bash
   cd src/server/api
   uv sync --frozen
   ```

4. Run the server:

For more detailed information, refer to the [server documentation](./src/server/readme.md#development).


## Development Workflow

1. Create a branch for your feature or bugfix:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes with frequent commits:
   ```bash
   git commit -m "feat: add your feature"
   ```

   *[Recommended commit message style](https://www.conventionalcommits.org/en/v1.0.0/)*
   
3. Write tests for your changes

4. Update documentation as needed

## Pull Request Process

1. Rebase your branch onto the latest Memoia `main` branch:
   ```bash
   git checkout main
   git pull origin main
   git checkout your-branch
   git rebase main
   ```

2. Fix up commits to maintain clean history:
   ```bash
   git rebase -i dev
   ```

3. Before submitting, ensure:
   - All tests pass
   - Code is properly formatted
   - Documentation is updated

4. Submit your PR with:
   - A clear title following the commit message format
   - A comprehensive description of your changes
   - References to any related issues



## PR or Issue?

- We will not accept document typo fix PR, just make an issue if you find any typo.

## Communication

If you have questions or need help, please:

- Check existing issues and documentation
- Create a new issue for discussion
- Use [Memoia issues](https://github.com/jianify-llc/memoia/issues); upstream community channels do not provide support for this fork.

Thank you for contributing to Memoia!

## Company branch and Test push contract

Follow the [company branch/release policy](https://github.com/jianify-llc/Jianify-LLC/blob/main/docs/engineering/branch-release.md). Ordinary development/Test pushes and development PRs do not start Actions. Install the local guard with `python3 scripts/test_push.py install`, then use `python3 scripts/test_push.py push` from a clean committed worktree to validate before syncing Test. Test publication requires an explicitly requested manual acceptance batch; production tags and approvals remain separate. Dependencies and local isolation are documented in [deploy/README.md](deploy/README.md#本地检查与明确-test-验收).
