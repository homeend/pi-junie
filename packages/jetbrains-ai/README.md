> **This is a copy.** It was taken on 2026-11-23 from `pi-extension-jetbrains-ai` 1.0.0 in the junie-pi repository
> (`packages/jetbrains-ai`). pi-junie registers its provider when `JUNIE_API_KEY` is set (the "JetBrains AI" model
> group, see `packages/junie-config`). Changes in this copy: package name `pi-junie-jetbrains-ai`, private; the live
> integration test (needs a key and model quota) is not copied.
>
> The text below is the original README.

# JetBrains AI extension for Pi

This package adds JetBrains AI as a Pi provider without modifying Pi's core.

Install from the repository root:

```sh
pi install ./packages/jetbrains-ai
```

Or run it for one session without installing:

```sh
pi -e ./packages/jetbrains-ai
```

After loading the extension, run `/login`, select **JetBrains**, and sign in in the browser. The callback returns to Pi through a loopback server on `localhost` (ports 62345–62364); if those ports are occupied, paste the authorization code. Then select a model, for example `/model jetbrains-ai/gpt-5.4`.

Pi stores the OAuth credential in its normal `auth.json` store and refreshes it automatically. Ingrazzio receives the OIDC ID token as a Bearer token, not the OAuth access token. This integration uses the `junie-cli` client and JetBrains production endpoints; it is not an independently registered JetBrains OAuth application.

As in Junie, you can authenticate with a Junie API key from https://junie.jetbrains.com/cli instead of the browser login:

```sh
JUNIE_API_KEY=... pi --model jetbrains-ai/gpt-5.4
```

The key can also be saved with `/login` → **JetBrains** → **Junie API key**. Like Junie, `JUNIE_API_KEY` takes precedence over a saved browser login; an explicitly passed or saved API key takes precedence over the environment variable. Junie API keys are sent as `Authorization: Bearer <key>`; GitHub tokens (`ghp_…`, `github_pat_…`) are sent as `Authorization: GitHub <token>`.

The catalog contains 34 models referenced by Junie's `ModelOption.Specific`, including deprecated entries and an internal Qwen model. Requests use the existing Pi OpenAI, Anthropic, Google, or OpenAI-compatible protocols. Catalog presence does not guarantee account entitlement or availability. Browser login requires Pi and the browser to run on the same machine. The extension does not implement license activation, quota display, or enterprise/JCP authentication.

Run the integration test with `npm test` from the repository root. It requires Pi on `PATH`, network access, and `JUNIE_API_KEY` in the repository-root `.env` (or exported); a saved login is not used. The test makes one live request to the cheapest catalog model, `gpt-6-luna`, and may consume model quota; it does not perform interactive login.
