/**
 * Vercel Speed Insights Integration
 * 
 * Initializes Vercel Speed Insights for performance monitoring.
 * This script is loaded after the main app initialization.
 */

(function() {
  'use strict';

  // Initialize the Speed Insights queue
  window.si = window.si || function() {
    (window.siq = window.siq || []).push(arguments);
  };

  // Load the Speed Insights script
  function loadSpeedInsights() {
    // Check if script is already loaded
    const existingScript = document.querySelector('script[src*="speed-insights"]');
    if (existingScript) {
      return;
    }

    // Create script element
    const script = document.createElement('script');
    
    // Use the Vercel-hosted script
    script.src = '/_vercel/speed-insights/script.js';
    script.defer = true;
    
    // Add SDK information
    script.dataset.sdkn = '@vercel/speed-insights';
    script.dataset.sdkv = '2.0.0';
    
    // Handle load errors
    script.onerror = function() {
      console.warn('[Vercel Speed Insights] Failed to load script. This is expected in local development.');
    };

    // Append to document head
    document.head.appendChild(script);
  }

  // Load when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadSpeedInsights);
  } else {
    loadSpeedInsights();
  }
})();
