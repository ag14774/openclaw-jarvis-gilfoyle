# Build and preview the documentation

This site uses standard [Zensical](https://zensical.org/docs/) **0.0.68** with `zensical.toml`, the bundled modern theme, native search and Markdown. There are no custom templates, JavaScript, analytics or remote fonts. The existing pixel logo is used unchanged.

## Reproducible environment

Use **Python 3.13.5** (the CI version) and **uv 0.12.10**. `pyproject.toml` pins Zensical; `uv.lock` pins its transitive dependencies and distribution hashes. From the repository root:

```bash
python3 -m pip install uv==0.12.10
uv sync --locked --python 3.13.5
uv run --locked zensical build --clean --strict
uv run --locked zensical serve
```

Preview at **<http://127.0.0.1:8000/>**. The configured address is loopback-only. Stop the foreground preview with Ctrl-C. `site/` is generated output; `.venv/` and `.cache/` are local build state. None belongs in a commit.

Edit pages under `docs/`, then update `nav` in `zensical.toml` when adding a page. Links to site pages should be relative Markdown links; links to source files outside `docs/` should point to the repository on GitHub. Those repository links require access to this private repository.

Before committing, run the strict clean build and the repository's formatter check. Review navigation, search results, light/dark appearance and mobile layout. Keep screenshots and validation logs outside `docs/` and `site/`. Review both source and generated output for private content before publication.

To upgrade dependencies deliberately, change the pin, regenerate with `uv lock`, review the lock diff and validate the site. Normal builds use `--locked` so they do not silently resolve a new environment.

## CI and publishing

`docs-check.yml` performs a strict clean build on pull requests with read-only repository permissions. It does not deploy or publish previews.

`docs-pages.yml` builds on pushes to **main**. Its build job has only repository read permission and uploads the normal Pages artifact; a separate `github-pages` deployment job has `pages: write` and `id-token: write`. Zensical build caching is not used in CI, following official publishing guidance.

The configured canonical URL is **`https://ageorgiou.com/openclaw-jarvis-gilfoyle/`**. Before enabling deployment, verify that the repository is eligible for Pages and select GitHub Actions as its publishing source. A private source repository can still produce a public site: review the generated artifact before publishing. A successful local or PR build does not establish that hosting is configured or live.

## Official guidance

- [Get started](https://zensical.org/docs/get-started/): Python virtual environments and uv installation.
- [Configuration basics](https://zensical.org/docs/setup/basics/): standard TOML project settings.
- [Colors](https://zensical.org/docs/setup/colors/) and [fonts](https://zensical.org/docs/setup/fonts/): palette toggle and system fonts.
- [Validation](https://zensical.org/docs/setup/validation/): internal links, anchors and strict builds.
- [Publishing](https://zensical.org/docs/publish-your-site/): GitHub Pages actions and publishing prerequisites.
