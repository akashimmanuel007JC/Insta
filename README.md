> Posting format: each story now generates one JPEG and publishes one photo post with a caption and hashtags. Older carousel descriptions below refer to the previous format. Music is not included.

# Daily Context — automated Instagram carousels

A Node.js 20 pipeline running entirely on GitHub Actions. At every posting slot it gathers stories from every category, deduplicates them, selects the highest-intensity candidate, writes grounded copy, generates an original illustration, deploys it through GitHub Pages, publishes one photo post, and collects next-day insights. The dashboard only reads `logs/posts.json`. No laptop or server is required after setup.

**Local verification uses simulated content and images. Live posting requires your accounts, credentials and GitHub Pages configuration.** The sole npm dependency is `sharp`; tests, schema validation, HTTP and orchestration use Node built-ins.

## Repository

```text
config.json                  Categories, source map, schedule, models, brand
src/sources/index.js         Guardian, GNews, NASA, Wikipedia, World Bank
src/select.js                One LLM ranking call
src/script.js                Strict schema + copy checks, one correction attempt
src/images.js                One image-generation request per slide + backoff
src/compose.js               1080×1350 JPEGs, typography, margins, watermark
src/host.js                  Commit images, retention, verify HTTPS JPEGs
src/publish.js               Quota, child/parent containers, polling, publish
src/log.js                   Atomic JSON writes, similarity, durable reservations
src/token.js                 Token maintenance and GitHub-secret persistence
src/alert.js                 Telegram alerts
src/main.js                  Prepare / publish stages
src/insights.js              Daily 24–48-hour insights collection
scripts/build-pages.js       Public allowlist: dashboard, images, posts.json
.github/workflows/post.yml   Eight wakeups, dispatch, jitter, deployment, publish
.github/workflows/insights.yml Daily insights + token maintenance + dashboard
logs/posts.json              Public post history (no article text or credentials)
logs/used.json               Story dedupe history
public/                      Static dashboard and retained JPEGs
output/                      Ignored private local results / short-lived artifacts
```

## Private Studio login and hosting

The interactive Studio (`npm run studio`) is protected by a signed, HttpOnly login cookie. The username is fixed as `akashimmanuel`; the password is deliberately not stored in source code. Before starting locally, add these values to your ignored `.env`:

```env
ADMIN_PASSWORD=choose-your-private-password
AUTH_SECRET=paste-a-long-random-secret-here
```

Generate a suitable signing secret with `openssl rand -base64 48`. Keep both values private and set the same environment variables in the hosting platform. The server refuses to start if either value is missing or if `AUTH_SECRET` is shorter than 32 characters.

```sh
npm run studio
```

Open `http://localhost:3000`; unauthenticated Studio pages and APIs redirect to the login screen. `/health` and generated JPEG files below `/output/` remain public so a cloud health check and Instagram image fetch can work. All other Studio assets and APIs require the signed session. Use the **Sign out** control to clear it.

The session cookie requests the practical browser maximum of 400 days and is renewed during authenticated use. Browsers, privacy settings, manual data clearing, and platform policies can still remove it, so no web login can guarantee a literally non-expiring cookie. HTTPS deployments receive the `Secure` cookie flag automatically, including behind a proxy that sends `X-Forwarded-Proto: https`.

To host the Studio on a Node platform such as Render, create a Web Service with build command `npm ci`, start command `node server.js`, and health-check path `/health`. Add `ADMIN_PASSWORD`, `AUTH_SECRET`, the AI/news/Instagram credentials, and set `PUBLIC_URL` to the service's public HTTPS origin. (`npm run studio` is the local command because it loads the ignored `.env`; cloud platforms inject environment variables directly.) The Studio's in-memory login rate limit resets when the service restarts, and free hosts may sleep or discard local files; GitHub Actions remains the durable unattended scheduler.

This login protects only the live Node Studio. The separate GitHub Pages output is intentionally public and contains only the dashboard allowlist, post history, and images assembled by `scripts/build-pages.js`; do not treat Pages as a private authenticated application.

## 1. Verify privately first

```sh
npm ci
npm test
npm run dry-run
```

`npm run dry-run` sets `DRY_RUN=true MOCK_APIS=true`: no API credentials or network needed. It writes five real JPEGs and `output/result.json`, prints the complete carousel, and changes only ignored `output/` files. Fixtures are deliberately synthetic, not news.

For real source/LLM/image API calls without public uploads or Instagram writes:

```sh
DRY_RUN=true MOCK_APIS=false node src/main.js
```

Provide credentials through your shell environment; Node does not auto-load `.env`. This mode can incur LLM/image costs. It never refreshes tokens, commits, hosts, sends Telegram messages, or publishes. Inspect every slide in `output/`. `SLOT_HOUR=9` overrides the nominal IST slot for testing; otherwise a private dry run uses the configured start hour (initially 07:00). Do not enable mock APIs for live mode; the program refuses.

## 2. Instagram account and Meta app

The two Meta login products use different IDs, permissions, tokens and hosts. **Do not mix them.** The default `instagram.loginMode: "instagram"` supports the requested automatic `/refresh_access_token` lifecycle. You may still connect the Business account to a Facebook Page, but Instagram Login does not require that connection.

1. In Instagram, switch the account to a professional **Business** account. Complete the profile and any required account checks.
2. To link a Page, create/select a Facebook Page you control, then use the Page's linked-accounts settings / Meta Business Suite to connect the Instagram Business account. Give the authenticating user appropriate Page access.
3. Create a Meta developer app, add the Instagram use case, and choose **API setup with Instagram Login** for the default configuration. Configure the OAuth redirect URL, add your account as a tester/app role when using development mode, and accept its invitation.
4. Authorize the account with `instagram_business_basic`, `instagram_business_content_publish`, and `instagram_business_manage_insights`. Follow the current app dashboard's permission review requirements. Accounts outside app roles generally require the applicable access review and Live mode.
5. Exchange the authorization code through the documented OAuth flow, then exchange the short-lived Instagram token for a long-lived token using `https://graph.instagram.com/access_token` with `grant_type=ig_exchange_token` and the Instagram app secret. Use a secure API client; do not paste credentials into repository files or terminal history. Store the resulting token as `IG_ACCESS_TOKEN` and the Instagram user ID returned by that login flow as `IG_USER_ID`.
6. Let the initial long-lived token age at least **24 hours** before the first daily maintenance run. The daily maintenance call first refreshes it and records only its expiry metadata in `logs/token.json`. Refresh runs at most weekly thereafter and persists the replacement in GitHub Secrets. Invalid/revoked/expired tokens still require reauthorization.
7. Set `instagram.apiVersion` to a supported version enabled for your app (the starting configuration is `v25.0`). Validate the app's publishing and insights permissions with a private dry run followed by one intentional live dispatch.

### Alternative: Facebook Login / connected Page

Set `instagram.loginMode` to `"facebook"`. Create/configure Facebook Login for Business in the Meta app. Obtain the appropriate Page access token through the authorized user and linked Page (`/me/accounts`), and find the Instagram Business account ID via the Page's `instagram_business_account` field. Permissions include `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, and `pages_read_engagement`; business-managed roles may require additional permissions as documented by Meta.

Exchange the initial short-lived Facebook user token for a long-lived token through `graph.facebook.com/{version}/oauth/access_token` with `grant_type=fb_exchange_token`, then obtain the Page token. Store the Page token in `IG_ACCESS_TOKEN`. Use the matching Facebook app ID/secret in `FB_APP_ID`/`FB_APP_SECRET`. This mode calls `graph.facebook.com` and checks validity/expiry through `debug_token`.

**Facebook tokens cannot be refreshed with Instagram's `/refresh_access_token`.** Some Page-token configurations have no scheduled expiration but can still be revoked. This mode alerts before a known expiry and requires reauthorization when necessary; it cannot promise indefinite automatic renewal. Use Instagram Login for the automatic refresh requirement.

## 3. GitHub repository, Secrets and Pages

Create/push this repository to GitHub with these files on the default branch. In Settings → Actions → General, allow the workflow's requested read/write repository permissions. Ensure branch rules permit this workflow's state commits. Protect changes to workflows: anyone able to run modified code with these secrets can access your accounts.

Add Settings → Secrets and variables → Actions → **Secrets**:

| Secret | Purpose |
| --- | --- |
| `LLM_API_KEY` | OpenAI key for the default structured-text adapter |
| `IMAGE_API_KEY` | OpenAI key for the default GPT Image adapter; may be same project key |
| `GUARDIAN_KEY` | Guardian Open Platform key |
| `GNEWS_KEY` | GNews key (optional if other category sources suffice) |
| `NASA_KEY` | NASA API key for Space |
| `IG_USER_ID` | ID from the selected Meta login product |
| `IG_ACCESS_TOKEN` | Matching long-lived Instagram token or Facebook Page token |
| `FB_APP_ID`, `FB_APP_SECRET` | Required for Facebook-mode token debugging; initial OAuth setup uses the matching app credentials |
| `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID` | Bot token and destination chat; start a conversation with your bot first |
| `GH_SECRETS_TOKEN` | **Additional credential for automatic token persistence:** fine-grained GitHub PAT restricted to this repository, repository **Secrets: write** permission |

`GITHUB_TOKEN` is supplied automatically for commits and Pages deployment, but cannot update Actions secrets. The preinstalled GitHub CLI encrypts refreshed tokens and updates `IG_ACCESS_TOKEN` using `GH_SECRETS_TOKEN`; tokens are passed on stdin, never written to files. Keep that PAT valid and rotate it before its expiry. Without it, Instagram-login live runs fail closed before publishing. No extra npm dependency is used.

Set **Variables** → `PAGES_BASE_URL` to the exact public HTTPS site root, e.g. `https://YOURNAME.github.io/YOURREPO` (or your configured custom domain). In Settings → Pages choose **GitHub Actions** as the build/deployment source. Configure the `github-pages` environment to allow deployments from the default branch without a manual reviewer if you want unattended runs. Public image access is required even if repository visibility is private; GitHub plan restrictions can apply.

The workflow explicitly uploads/deploys a Pages artifact. It does not depend on commits made by `GITHUB_TOKEN` triggering another workflow. Only the dashboard, JPEGs and `posts.json` enter Pages. `used.json`, token metadata, source article text, and private artifacts are excluded.

Run Actions → Scheduled carousel → Run workflow first with **dry_run=true**, **mock_apis=true**. Inspect the private `private-run-output` artifact (two-day retention). Then test real APIs with dry_run=true, mock_apis=false. To intentionally publish, set both to false. Scheduled runs always use real APIs and publish automatically; a manual trigger is not required at runtime.

## 4. Schedule and rotation

UTC cron: `30 1,3,5,7,9,11,13,15 * * *`, corresponding to 07:00, 09:00, …, 21:00 IST. Each scheduled posting run adds a uniformly random 0–600 second delay. GitHub can delay or drop scheduled jobs, so these are scheduled slots, not guaranteed posting times. Late jobs outside the configured 90-minute allowance skip; no catch-up flood occurs. Public-repository scheduled workflows may be disabled after extended repository inactivity; consult GitHub's current scheduling rules.

`config.json` starts at **6 posts/day**. The workflow wakes eight times and the app rotates two omitted slots. Set `schedule.dailyPosts` to 8 when ready. Active hours and count are configured in JSON; the cron provides the maximum wakeup envelope. Start/end hours must be odd hours within 07–21 and intervalHours must be 2. Expanding outside that envelope also requires editing cron; validation rejects unsupported settings.

Categories rotate daily plus an extra phase shift each complete slot cycle. This decouples category selection from omitted slots, so every category reaches different times over subsequent weeks. Test coverage checks eight weeks. The original slot is stored even when GitHub runs late. A shared `instagram-state` concurrency group serializes both workflows. GitHub can replace pending runs; the system does not assume every scheduled event executes.

## Content and source behavior

Edit `categories` and the corresponding `sources` map. Every category must have a source configuration. The pipeline requests up to 30 candidates, with Guardian normally providing 30 and GNews up to 10; NASA/Wikipedia are supplementary. Availability, API quotas and topic filtering can yield fewer than 20. It never pads a short list with invented stories. GNews's free tier can delay news and truncate text; only supplied text is used. Configure provider keys and queries so each category has adequate coverage. Review source licensing/plan terms for your intended use, especially commercial use.

NASA uses APOD explanations, never its images. Wikipedia uses the current news feed and category keyword filtering. World Bank supplies explicitly dated **historical annual facts**, not breaking news; scripts must retain that context. Publisher image URLs are neither stored nor fetched. Article text is transient input and is not committed or copied into captions.

Automatic selection does not use an LLM. It assigns each eligible story a deterministic 0–100 intensity score based on freshness, corroboration by independent sources, restrained urgency signals, and measurable impact. Freshness and corroboration carry most of the weight so sensational wording alone cannot dominate. Script generation is one structured-output LLM call plus at most one correction call. Local schema validation checks exact keys, roles, source metadata, word limits, hashtags, caption disclosure, unsupported numeric strings and long verbatim passages. These checks reduce errors but cannot prove every paraphrased claim true. The prompt forbids outside facts and treats articles as untrusted input. Always evaluate initial dry-run quality before enabling unattended publication.

The requested 5–7 total slides and 2–4 story slides conflict at seven slides (hook + five stories + CTA). This implementation emits **5–6 slides**: hook, 3–4 story slides, CTA, satisfying both ranges. Headlines are capped at 10 words on every slide. Images are conceptual paper-cut illustrations with no text, people or realistic event reenactment. Sharp adds the actual text, watermark and disclosure on 1080×1350 JPEGs. Prompts cannot mathematically guarantee image-model compliance; inspect initial results.

Change the brand name/watermark before launch. Ubuntu's `DejaVu Sans` is the default font. API models/base URLs are configurable; alternative providers must implement the same request/response formats or need an adapter.

## Failure safety and recovery

A slot record is created before work; exhausted failures skip the slot and send a Telegram alert. Source providers can fail independently; remaining usable sources may proceed. GETs and image requests retry transient failures with exponential backoff. Instagram mutations are not blindly retried.

Token refresh runs in the daily workflow so a subsequent posting workflow receives the updated repository secret when it starts.

Before hosting/publishing, the story is marked `posting`, added to `used.json`, and **pushed to GitHub**. If this checkpoint fails, publication does not start. Each child ID, parent ID and publish intention is persisted before the next stage. Child and parent containers are polled every five seconds, with a five-minute limit per container; ERROR/EXPIRED stop immediately. Publishing quota is checked before container creation and again before the final publish request.

A lost response, process crash or uncertain publish leaves a durable `posting`/`uncertain` reservation. Reruns never automatically publish that story again. This deliberately favors a missed post over a duplicate: Instagram does not provide a client idempotency key that makes exactly-once publication possible across network failures.

To resolve a reservation, first inspect Instagram and the stored container ID/status in Meta. If published, record the actual media ID and `status: "published"` in `logs/posts.json`. If definitively unpublished, mark the record `failed`; remove the associated `used.json` entry only if you want the story eligible after review. The original failed slot remains skipped. Never clear an uncertain record simply to rerun. Commit reviewed state changes to the default branch.

URL and normalized-title similarity suppress stories from the last 30 days; uncertain story locks have no automatic expiry. This is lexical dedupe, not semantic event clustering, so differently worded coverage can evade it. Failed-slot alerts and Actions logs expose missing credentials, image failures, Pages failures, API limits and token problems. Infrastructure failures can prevent application-level logging; the workflow-level alert handles failed jobs when runners remain available.

JPEG working-tree files older than seven days are removed before new image staging. **Git retains old blobs in history**; deleting files does not shrink history. Monitor repository size and periodically archive/recreate the image history if needed. No destructive history rewriting is automated.

## Insights and dashboard

The separate daily workflow runs at 23:45 IST. It samples published posts aged 24–48 hours, retrieves `reach,saved,shares,likes,comments`, stores `saved` as `saves`, and preserves missing/error results instead of reporting zero. A missed daily run can miss a post's window; failed insights are logged. Measurements are one next-day snapshot, not lifetime continuously refreshed totals.

The static dashboard presents category comparisons, slot comparisons, sample counts, reach/saves/shares, and posting history. It has no credentials or write operations. It reads the deployed copy of `logs/posts.json`; refreshes follow Pages deployments, not a live database. Reach summed across posts is not unique audience reach.

Preview after building:

```sh
node scripts/build-pages.js
python3 -m http.server --directory .pages-build 8000
```

Open `http://localhost:8000`. An empty repository correctly shows an empty state.

## API references

- [Meta's official Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)
- [Instagram Login and token lifecycle](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login)
- [Instagram content publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat)
- [OpenAI image generation](https://developers.openai.com/api/reference/resources/images/methods/generate)
- [Guardian Open Platform](https://open-platform.theguardian.com/documentation/)
- [GNews free-tier limits and endpoints](https://docs.gnews.io/)
- [NASA APIs](https://api.nasa.gov/)
- [Wikimedia APIs](https://www.mediawiki.org/wiki/Wikimedia_APIs)
- [World Bank API queries](https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures)
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

## Local Azure configuration

The project now supports `llm.provider` and `image.provider` set to `azure` or `openai` independently. Your local Azure settings are loaded from ignored `.env` only when running:

```sh
npm run local
```

Requires Node 20.9+ and always runs privately: real API calls, local JPEGs, no hosting or Instagram publishing. The command validates provider settings before spending on generation. Set these in `.env`:

- `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION`
- `AZURE_OPENAI_DEPLOYMENT`: optional override; defaults to `llm.model` in `config.json`
- `AZURE_OPENAI_IMAGE_API_KEY_1`, `AZURE_OPENAI_IMAGE_ENDPOINT_1`, `AZURE_OPENAI_IMAGE_API_VERSION_1`
- `AZURE_OPENAI_IMAGE_DEPLOYMENT`: optional override; defaults to `image.model` in `config.json` (the image adapter requires GPT Image-compatible parameters and base64 output)
- `GUARDIAN_KEY`: your news-source key; optional GNews/NASA keys may also be added

Separate deployment environment variables are optional. The configured model names are used in Azure request routes unless overridden; they must match deployments available in the resource. Image and text resources may use separate keys. Use ASCII `API` in environment variable names.

The supplied text API version uses `llm.responseFormat: "json_object"`; the schema is supplied in the prompt and local validation still enforces script structure. For a deployment/API version supporting strict structured outputs, use `"json_schema"`. Azure model availability and permissions must be verified in your account. See [Microsoft's JSON mode documentation](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/json-mode).

For GitHub Actions with Azure enabled, add the same Azure variables as repository Actions secrets; `.env` is never committed or loaded in cloud jobs. `npm run dry-run` remains an offline mock test.

### Profile Studio

The Studio includes prompt-based bio and profile-picture generation using the configured text and image providers. Bios can be edited and copied (150 characters maximum); profile pictures are square JPEGs with a circular preview and download control. Generated results remain in the current browser page and are lost on refresh.

These are drafts: this integration does not update your Instagram bio or profile picture. Use the Instagram profile link to paste the bio and upload the downloaded picture manually. Restart `npm run studio` after updating the code. No extra credentials beyond the existing AI provider configuration are needed.

### Schedule monitor

The Studio displays today's active posting slots and the next planned time/topic in IST, with a countdown. It uses the same rotating-slot logic as the publisher and reads outcomes from local logs. The local Studio does not execute scheduled posts: those run through GitHub Actions. Runner availability and remote outcomes are not verified by this display; an elapsed slot without a log entry means only that its planned time has passed. Refreshing the monitor does not trigger a post.
