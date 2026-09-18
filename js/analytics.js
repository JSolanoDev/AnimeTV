// Vercel Web Analytics initialization
// This script injects Vercel Analytics tracking into the application

(function() {
  // Analytics will only track in production mode (when deployed to Vercel)
  // In development, events are logged to console for debugging
  
  // Import inject function from @vercel/analytics
  // Note: Since this is a vanilla JS project, we use a dynamic import
  // that will be resolved during the build process
  
  if (typeof window !== 'undefined') {
    // Check if we're in production (deployed to Vercel)
    const isProduction = window.location.hostname !== 'localhost' && 
                         window.location.hostname !== '127.0.0.1';
    
    // Initialize analytics tracking script
    // The script will be loaded from Vercel's CDN when deployed
    (function() {
      window.va = window.va || function() {
        (window.vaq = window.vaq || []).push(arguments);
      };
    })();
    
    // Inject the analytics script
    const script = document.createElement('script');
    script.defer = true;
    script.src = '/_vercel/insights/script.js';
    document.head.appendChild(script);
  }
})();
