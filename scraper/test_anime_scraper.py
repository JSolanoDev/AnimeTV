import unittest
from unittest.mock import patch

import anime_scraper as scraper


class AnimeAv1CatalogTests(unittest.TestCase):
    def test_filtered_pagination_reads_encoded_and_raw_ampersands(self):
        html = """
            <a href="/catalogo?letter=A&amp;page=13">13</a>
            <a href="/catalogo?letter=A&page=12">12</a>
        """
        self.assertEqual(scraper._animeav1_catalog_page_count(html), 13)

    def test_unlimited_catalog_uses_every_partition(self):
        urls = scraper._animeav1_catalog_partition_urls("https://animeav1.com/catalogo")
        self.assertEqual(len(urls), 27)
        self.assertEqual(urls[0], "https://animeav1.com/catalogo?letter=%23")
        self.assertEqual(urls[1], "https://animeav1.com/catalogo?letter=A")
        self.assertEqual(urls[-1], "https://animeav1.com/catalogo?letter=Z")

    def test_previous_metadata_and_missing_rows_survive_refresh(self):
        previous = {
            "items": [
                {
                    "id": "animeav1-dragon-ball",
                    "title": "Old Dragon Ball",
                    "_slug": "dragon-ball",
                    "poster": "https://images.example/poster.jpg",
                    "episodes": [{"number": 1}],
                },
                {
                    "id": "animeav1-dragon-ball-z",
                    "title": "Dragon Ball Z",
                    "_slug": "dragon-ball-z",
                    "poster": "https://images.example/z.jpg",
                },
            ]
        }
        fresh = [
            {
                "id": "animeav1-dragon-ball",
                "title": "Dragon Ball",
                "_slug": "dragon-ball",
                "siteUrl": "https://animeav1.com/media/dragon-ball",
                "source": "AnimeAV1",
            }
        ]

        merged = scraper.preserve_previous_animeav1_metadata(fresh, previous)

        self.assertEqual(len(merged), 2)
        dragon_ball = next(row for row in merged if row["_slug"] == "dragon-ball")
        self.assertEqual(dragon_ball["title"], "Dragon Ball")
        self.assertEqual(dragon_ball["poster"], "https://images.example/poster.jpg")
        self.assertEqual(dragon_ball["episodes"], [{"number": 1}])
        self.assertTrue(any(row["_slug"] == "dragon-ball-z" for row in merged))

    def test_catalog_growth_does_not_hide_a_missing_old_title(self):
        previous = {"items": [
            {"id": "animeav1-retained", "_slug": "retained", "title": "Retained"},
            {"id": "animeav1-missing", "_slug": "missing", "title": "Missing", "sourceEpisodeIds": [1, 2]},
        ]}
        fresh = [{"id": f"animeav1-{slug}", "_slug": slug, "title": slug}
                 for slug in ("retained", "new-one", "new-two")]
        merged = scraper.preserve_previous_animeav1_metadata(fresh, previous)
        self.assertEqual(len(merged), 4)
        self.assertEqual(next(row for row in merged if row["_slug"] == "missing")["sourceEpisodeIds"], [1, 2])

    def test_recent_episode_window_preserves_old_episodes_and_other_seasons(self):
        show = {
            "id": "animeav1-current", "title": "Current", "source": "AnimeAV1", "seasonNumber": 2,
            "episodes": [{"season": 2, "episode": 1, "videoUrl": "https://video.test/one.mp4"}],
            "seasons": [
                {"season": 1, "episodes": [{"season": 1, "episode": 1}]},
                {"season": 2, "title": "Season 2", "episodes": [{"season": 2, "episode": 1}]},
            ],
        }
        with patch.dict(scraper._SITE_EPISODE_FETCHERS, {"animeav1": ("AnimeAV1", lambda *_: [
            {"season": 2, "episode": 2, "siteUrl": "https://animeav1.com/media/current/2"},
        ])}):
            scraper.enrich_episodes(show, 1, ["animeav1"])
        self.assertEqual([episode["episode"] for episode in show["episodes"]], [1, 2])
        self.assertEqual(len(show["seasons"]), 2)
        self.assertEqual([episode["episode"] for episode in show["seasons"][1]["episodes"]], [1, 2])
        self.assertEqual(show["episodes"][0]["videoUrl"], "https://video.test/one.mp4")

    def test_empty_new_fields_do_not_erase_saved_episode_metadata(self):
        old = [{"season": 1, "episode": 1, "title": "Saved title", "siteUrl": "saved-route"}]
        new = [{"season": 1, "episode": 1, "title": "", "siteUrl": ""}]
        self.assertEqual(scraper.merge_saved_episodes(old, new), old)

    def test_optional_canonical_fields_and_malformed_numbers_do_not_break_merging(self):
        old = [{"season": 2, "episode": 1, "title": "Saved"}]
        new = [
            {"canonicalSeason": None, "canonicalEpisode": None, "season": 2, "episode": 2},
            {"season": 2, "episode": "unknown"},
            {"season": 2, "episode": float("nan")},
            {"season": 2, "episode": float("inf")},
        ]
        self.assertEqual([episode["episode"] for episode in scraper.merge_saved_episodes(old, new)], [1, 2])


if __name__ == "__main__":
    unittest.main()
