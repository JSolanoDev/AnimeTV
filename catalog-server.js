const http = require('http');

const catalog = {
  items: [
    {
      id: "test-anime-1",
      title: "Test Anime - Sample Video",
      image: "https://via.placeholder.com/300x450?text=Test+Anime",
      description: "This is a test video to verify playback works.",
      videoUrl: "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
      episodes: [
        {
          episode: 1,
          title: "Sample Episode",
          server: "Google Sample",
          videoUrl: "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4"
        },
        {
          episode: 2,
          title: "Second Sample",
          server: "Google Sample", 
          videoUrl: "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlues.mp4"
        }
      ]
    }
  ]
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(catalog));
});

server.listen(5050, () => {
  console.log('Test catalog at http://localhost:5050');
  console.log('Enable "My Local Anime Catalog" in AnimeTV Sources tab');
});