import unittest

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


if __name__ == "__main__":
    unittest.main()
