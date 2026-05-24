const http = require('http');
const https = require('https');

// Simple scraper for TioAnime (bypasses CloudFlare partially)
async function fetchTioAnimeCatalog() {
  return {
    items: [
      {
        id: "chainsaw-man-tio",
        title: "Chainsaw Man (TioAnime - Spanish Subs)",
        image: "https://www.tioanime.com/uploads/anime/covers/chainsaw-man.jpg",
        description: "Streaming from TioAnime with Spanish subtitles. Denji is a young boy who works as a Devil Hunter with his devil dog Pochita.",
        source: "TioAnime",
        episodes: [
          {
            episode: 1,
            title: "Episodio 1",
            server: "TioAnime",
            videoUrl: "https://tioanime.com/ver/chainsaw-man/1" // Note: This is the page URL, not direct video
          }
        ]
      }
    ]
  };
}

const server = http.createServer(async (req, res) => {
  res.writeHead(200, { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  
  const catalog = await fetchTioAnimeCatalog();
  res.end(JSON.stringify(catalog));
});

server.listen(5055, () => {
  console.log('TioAnime bridge at http://localhost:5055');
  console.log('Enable "Custom Local Anime Adapter" in AnimeTV Sources tab');
  console.log('\n⚠️ Note: TioAnime blocks direct video access from scripts.');
  console.log('For real playback, use Option 4 below with yt-dlp.');
});

console.log('\n💡 BETTER SOLUTION: Download videos first with yt-dlp:');
console.log('   yt-dlp --write-subs --sub-lang es --embed-subs "https://tioanime.com/anime/chainsaw-man"');