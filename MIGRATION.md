# Migration Guide: flue-repo-assistant → Flowly

**Date**: August 4, 2026  
**Status**: In Progress

## Overview

This project has been rebranded from **flue-repo-assistant** to **Flowly** to better reflect its evolution from a repository-only assistant into a broader AI-native engineering platform.

## What Changed

### Package Name
- **Old**: `flue-repo-assistant`
- **New**: `flowly`

### Repository URL
- **Old**: `https://github.com/jellydn/flue-repo-assistant`
- **New**: `https://github.com/jellydn/flowly`

### Project Description
- **Old**: "A bounded, read-only repository analysis agent built with Flue."
- **New**: "AI-native engineering assistant for modern development."

## For Users

### If You're Cloning for the First Time

```bash
git clone https://github.com/jellydn/flowly.git
cd flowly
npm install
cp .env.example .env
```

### If You Have an Existing Clone

#### Option 1: Update Remote URL (Recommended)
GitHub automatically redirects the old URL to the new one, so your existing clone will continue to work. However, it's recommended to update your remote:

```bash
cd flue-repo-assistant  # your existing directory
git remote set-url origin https://github.com/jellydn/flowly.git
git remote -v  # verify the change
```

#### Option 2: Fresh Clone
If you prefer to start fresh:

```bash
# Backup any local changes first
cd flue-repo-assistant
git stash  # or commit your changes

# Clone the new repository
cd ..
git clone https://github.com/jellydn/flowly.git
cd flowly

# Restore your .env if needed
cp ../flue-repo-assistant/.env .env
```

### Package Name

The npm package name has changed from `flue-repo-assistant` to `flowly`. If you've installed it globally or referenced it in any scripts, update those references.

## For Contributors

### Branch Names
No changes required - existing branch names and pull requests will continue to work.

### CI/CD
- Workflow names have been updated but functionality remains the same
- Badge URLs in your forks may need updating if you reference the main repo

### Environment Variables
All environment variables remain unchanged:
- `REPO_ASSISTANT_MODEL`
- `REPO_ASSISTANT_MAX_STEPS`
- `REPO_ASSISTANT_DEBUG`
- etc.

These variable names are kept for backward compatibility.

## Breaking Changes

**None**. This is a naming/branding change only. All functionality, APIs, commands, and configurations remain identical.

## Timeline

- **August 4, 2026**: Rebranding announced (issue #84)
- **TBD**: Repository rename on GitHub (requires manual action)
- **TBD**: npm package publication under new name

## Backward Compatibility

### GitHub Redirects
After the repository is renamed on GitHub:
- Old URLs (`jellydn/flue-repo-assistant`) automatically redirect to new URLs (`jellydn/flowly`)
- Existing clones, forks, and links continue to work
- CI badge URLs update automatically

### Package Name
- The old package name (`flue-repo-assistant`) may be deprecated on npm
- Users should update to `flowly` for future releases

### Environment Variables
- All `REPO_ASSISTANT_*` environment variables remain unchanged
- No breaking changes to configuration

## Support

If you encounter any issues during migration:
1. Check this guide for updates
2. Open an issue on [GitHub](https://github.com/jellydn/flowly/issues)
3. Reference issue #84 for the original rebranding decision

## Rationale

The rebranding enables Flowly to expand beyond repository review into:
- Multi-agent workflows
- Advisor models
- Repository intelligence
- Engineering automation
- Future implementation agents

The old name was tightly coupled to "repository assistant," while Flowly better represents the platform's broader vision.
