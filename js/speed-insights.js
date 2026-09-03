// Vercel Speed Insights initialization
// This script loads and initializes Vercel Speed Insights for performance monitoring

(function() {
  'use strict';
  
  // Initialize the Speed Insights queue
  window.si = window.si || function() {
    (window.siq = window.siq || []).push(arguments);
  };

  // Load the Speed Insights script
  function loadSpeedInsights() {
    // Check if we're in a browser environment
    if (typeof window === 'undefined') return;
    
    // Check if script is already loaded
    const scriptSrc = '/_vercel/speed-insights/script.js';
    if (document.head.querySelector(`script[src*="${scriptSrc}"]`)) {
      return;
    }

    // Create and inject the script
    const script = document.createElement('script');
    script.src = scriptSrc;
    script.defer = true;
    
    // Add SDK metadata
    script.dataset.sdkn = '@vercel/speed-insights';
    script.dataset.sdkv = '2.0.0';
    
    script.onerror = function() {
      console.log(
        '[Vercel Speed Insights] Failed to load script from ' + scriptSrc + '. ' +
        'Please check if any content blockers are enabled and try again.'
      );
    };
    
    document.head.appendChild(script);
  }

  // Load on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadSpeedInsights);
  } else {
    loadSpeedInsights();
  }
})();
