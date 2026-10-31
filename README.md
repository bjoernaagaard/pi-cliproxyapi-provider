# pi CLIProxyAPI provider

The pi CLIProxyAPI provider is an extension for the [pi](https://github.com/earendil-works/pi) coding agent that lets pi use every model on a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) server. CLIProxyAPI is a local server that puts your Claude, Codex, Kimi, Grok, and other accounts behind one API key.

The extension sends each model through the API that suits it. Claude and Kimi models use the Anthropic Messages API, so cache marks and Anthropic options reach the model. Every other model uses the OpenAI Responses API.

## What you get

- A model list that comes from your CLIProxyAPI server, with the context windows and reasoning levels the server reports, and prices from [models.dev](https://models.dev)
- A `web_search` tool that runs searches through CLIProxyAPI and estimates what each search cost, when the server reports token usage
- A footer that shows tokens per second, and account usage if you add a management key
- Commands for Fast mode, pausing requests, and adding upstream accounts

## Requirements

- Node.js 22.19 or later
- pi 0.82 or later
- A running CLIProxyAPI server and an API key for it

## Install

Install the package with pi:

```sh
pi install npm:@juvio15/pi-cliproxyapi-provider
```

Then start pi and run `/login cliproxyapi`. Pi asks for the server address and the API key, and the extension checks them by loading the model list. If you leave the address empty, the extension uses `http://127.0.0.1:8317`, which is the CLIProxyAPI default.

## Connect without logging in

You can set the connection in environment variables instead, which is useful when you run pi in scripts or other programs that have no login screen:

```sh
export CLIPROXYAPI_BASE_URL=http://127.0.0.1:8317
export CLIPROXYAPI_API_KEY=your-key
```

The extension looks for each value in the environment first, then in `~/.pi/agent/cliproxyapi.json`, and then in the `/login` credentials. The address can be the server root or any of its API paths, e.g., `http://host:8317/v1`.

## Commands

| Command | What it does |
| --- | --- |
| `/login cliproxyapi` | Saves the server address and API key |
| `/cliproxyapi-status` | Shows the connection, model count, prices, and settings |
| `/cliproxyapi-refresh` | Loads the model list from the server again |
| `/cliproxyapi-login <provider>` | Adds an upstream account to CLIProxyAPI, e.g., `claude` or `codex` |
| `/cliproxyapi-reset [model-id]` | Clears CLIProxyAPI cooldowns for every account, or only for the accounts that serve one model |
| `/fast` | Turns Fast mode on or off for models that support it |
| `/pause` and `/continue` | Holds provider requests until you continue |
| `/websearch-model [model-id\|auto]` | Picks the model that `web_search` uses |

The extension caches the model list for 10 minutes. It hides models that the server no longer lists, and models whose accounts have hit their usage limits.

## Settings file

You can put settings in `~/.pi/agent/cliproxyapi.json`. Every field is optional:

```json
{
  "baseUrl": "http://127.0.0.1:8317",
  "apiKey": "your-key",
  "managementKey": "your-management-key",
  "fast": false,
  "pause": false,
  "searchModel": "<model-id>",
  "thinkingDisplay": { "<model-id>": "summarized" },
  "providerId": "cliproxyapi",
  "providerName": "CLIProxyAPI"
}
```

The fields work as follows:

- `managementKey` is the CLIProxyAPI management key. It turns on the usage footer, `/cliproxyapi-login`, and `/cliproxyapi-reset`. You can also set it with the `CLIPROXY_MANAGEMENT_KEY` environment variable.
- `thinkingDisplay` sets, per model, whether the model sends thought summaries. It applies to models that use the Anthropic Messages API with thinking turned on. The default is `omitted`, because Claude streams its answer only when summaries are off. Set a model to `summarized` to see its summaries.
- `searchModel` sets the model for `web_search`. When it's empty, the extension picks one.
- `providerId` is the provider ID that pi uses in model names, e.g., `cliproxyapi/<model-id>`, and in `/login`. If you change it, pi looks for the login under the new ID, so you need to log in again. `providerName` is the name pi shows. The environment variables `CLIPROXYAPI_PROVIDER_ID` and `CLIPROXYAPI_PROVIDER_NAME` do the same.

## Use the model mapping outside pi

The files in `src/core` don't import `pi-coding-agent`, and they don't read files or environment variables on their own. Programs built on `pi-ai` can import them to load the catalog, pick an API per model, and build a provider. The list of exported functions is at the top of `src/core/index.ts`.

## Development

Install the dependencies and run the checks:

```sh
npm install
npm run typecheck
npm run check
npm test
```

The scripts in `test/e2e` call a live CLIProxyAPI server, and `npm test` doesn't run them. Run one by hand, e.g., `node test/e2e/catalog.ts`. They use `CLIPROXYAPI_BASE_URL` and `CLIPROXYAPI_API_KEY`, or your pi login if those aren't set.

## License

MIT
