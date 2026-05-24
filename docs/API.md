# AnimeTV API

## Health

`GET /api/health`

Returns app status and daily refresh status.

## Main Catalog

`GET /api/catalog`

Returns metadata from AniList and Jikan. This catalog is metadata-first and may not include playable URLs.

## AniPub

`GET /api/anipub/catalog/all?limit=12000`

Loads the paginated AniPub catalog using the working `findbyrating` endpoint and caches results.

`GET /api/anipub/episodes/:id`

Fetches episode embeds from AniPub details and returns iframe entries as `externalUrl` plus `externalType: "iframe"`.

## Anime1v

`GET /api/anime1v/health`

Checks the local Anime1v API and reports `ok`, `degraded`, `quota`, or `offline`.

`GET /api/anime1v/search?q=naruto`

Searches Anime1v providers through the local API.

`GET /api/anime1v/trending`

Builds a larger Anime1v catalog from multiple provider searches when quota allows.

`GET /api/anime1v/episodes?url=...`

Returns normalized episodes.

`GET /api/anime1v/stream?url=...`

Returns direct playable stream fields and source options when the provider allows it.

## Daily Refresh

`GET /api/refresh-daily?background=1`

Starts a background refresh of heavy catalogs. The server also schedules this automatically once per day.
