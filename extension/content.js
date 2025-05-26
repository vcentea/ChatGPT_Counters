// Simple vanilla JavaScript content script to avoid module loading issues

// Global variables
let currentModel = null; // NOW STORES RAW MODEL SLUG/NAME FROM WEBSITE
let uiInitialized = false;
let bubbleElement = null;
let isModelMeterInitialized = false; // Guard to prevent multiple initializations
let lastProcessedMessageId = null; // To avoid processing the same message multiple times
let processedMessageIds = new Set(); // Track processed message IDs to avoid double counting
let inPagePanel = null;
let panelToggleButton = null; // This will be our existing bubbleElement
let originalFetch = null; // To store the original fetch function
let extensionContextValid = true; // Track extension context validity
let reloadMessageShown = false; // Track if reload message is already shown

// Constants
const API_ENDPOINTS = [
  'https://chatgpt.com/backend-api/f/conversation',
  'https://chatgpt.com/backend-api/conversation',
  'https://chatgpt.com/backend-api/v1/conversation',
];
// Add the specific endpoint known to use SSE for conversation details
const SSE_ENDPOINT_FRAGMENT = '/backend-api/conversation'; // More general check for SSE endpoint

// Utility function to safely send messages to background script
async function safeSendMessage(message, options = {}) {
  const { suppressErrors = false, retries = 0 } = options;
  
  // If we know the context is invalid, don't even try
  if (!extensionContextValid && !suppressErrors) {
    console.log('ModelMeter Content: Extension context known to be invalid, skipping message');
    showReloadPageMessage('Extension context invalidated. Please refresh the page to restore ModelMeter functionality.');
    return null;
  }
  
  try {
    const response = await chrome.runtime.sendMessage(message);
    return response;
  } catch (error) {
    if (error.message && error.message.includes('Extension context invalidated')) {
      extensionContextValid = false;
      if (!suppressErrors) {
        handleExtensionContextError(`safeSendMessage-${message.action || 'unknown'}`);
      }
    } else if (error.message && error.message.includes('Could not establish connection')) {
      extensionContextValid = false;
      if (!suppressErrors) {
        console.error('ModelMeter Content: Could not establish connection to background script');
        showReloadPageMessage('ModelMeter cannot connect to background script. Please refresh the page to restore functionality.');
        handleExtensionContextError(`safeSendMessage-connection-${message.action || 'unknown'}`);
      }
    } else {
      console.error('ModelMeter Content: Error sending message to background:', error);
    }
    
    // Retry logic for transient errors (but not for context invalidation)
    if (retries > 0 && extensionContextValid) {
      console.log(`ModelMeter Content: Retrying message send (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return safeSendMessage(message, { suppressErrors, retries: retries - 1 });
    }
    
    return null;
  }
}

// Function to show reload page message on the ChatGPT page
function showReloadPageMessage(customMessage = null) {
  // Prevent showing multiple reload messages
  if (reloadMessageShown) {
    return;
  }
  
  try {
    // Safety check - don't try to manipulate DOM if document.body doesn't exist
    if (!document || !document.body) {
      console.log('ModelMeter Content: document.body not available, cannot display reload message');
      return;
    }
    
    // Remove any existing reload messages to avoid duplicates
    const existingMessages = document.querySelectorAll('.modelmeter-reload-message');
    existingMessages.forEach(msg => {
      try {
        msg.remove();
      } catch (e) {
        // Silently ignore removal errors
      }
    });
    
    // Create a new reload message
    const reloadDiv = document.createElement('div');
    reloadDiv.className = 'modelmeter-reload-message';
    reloadDiv.style.cssText = `
      position: fixed;
      top: 10px;
      left: 50%;
      transform: translateX(-50%);
      background-color: #fef3c7;
      color: #92400e;
      border: 1px solid #f59e0b;
      border-radius: 8px;
      padding: 12px 16px;
      z-index: 10000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      max-width: 500px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      text-align: center;
    `;
    
    // Create close button
    const closeButton = document.createElement('button');
    closeButton.textContent = '×';
    closeButton.style.cssText = `
      position: absolute;
      top: 5px;
      right: 8px;
      border: none;
      background: none;
      color: #92400e;
      font-size: 18px;
      cursor: pointer;
      padding: 0;
      margin: 0;
      width: 20px;
      height: 20px;
      line-height: 18px;
      text-align: center;
      font-weight: bold;
    `;
    closeButton.onclick = function() {
      try {
        reloadDiv.remove();
        reloadMessageShown = false;
      } catch (e) {
        // Silently ignore removal errors
      }
    };
    
    // Message content
    const messageP = document.createElement('p');
    messageP.textContent = customMessage || 'ModelMeter content script not responding. Please refresh the page to restore full functionality.';
    messageP.style.margin = '0 0 10px 0';
    messageP.style.paddingRight = '20px'; // Make room for close button
    
    // Refresh button
    const refreshButton = document.createElement('button');
    refreshButton.textContent = 'Refresh Page';
    refreshButton.style.cssText = `
      background-color: #f59e0b;
      color: white;
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      margin-top: 8px;
      transition: background-color 0.2s;
    `;
    refreshButton.onmouseover = function() {
      this.style.backgroundColor = '#d97706';
    };
    refreshButton.onmouseout = function() {
      this.style.backgroundColor = '#f59e0b';
    };
    refreshButton.onclick = function() {
      window.location.reload();
    };
    
    // Build and append the reload message
    reloadDiv.appendChild(closeButton);
    reloadDiv.appendChild(messageP);
    reloadDiv.appendChild(refreshButton);
    
    // Try to append to document body with error handling
    try {
      document.body.appendChild(reloadDiv);
      reloadMessageShown = true;
      
      // Auto-hide after 30 seconds
      setTimeout(() => {
        try {
          if (reloadDiv.parentNode) {
            reloadDiv.remove();
            reloadMessageShown = false;
          }
        } catch (e) {
          // Silently ignore removal errors
        }
      }, 30000);
      
    } catch (error) {
      console.error('ModelMeter Content: Failed to append reload message to document.body', error);
    }
  } catch (error) {
    console.error('ModelMeter Content: Error creating reload message UI', error);
  }
}

// Wait for DOM to be ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  initialize();
} else {
  document.addEventListener('DOMContentLoaded', initialize);
}

// Ensure the timestamp_utils.js and storage_utils.js scripts are loaded
function loadUtilScripts() {
  return new Promise((resolve, reject) => {
    try {
      // Check if the scripts are already loaded
      if (window.ModelMeterUtils && window.StorageUtils) {
        console.log('ModelMeter Content: Utils already loaded, continuing');
        resolve();
        return;
      }

      // Safety check - if document.head doesn't exist, we wait and retry
      if (!document || !document.head) {
        console.log('ModelMeter Content: document.head not available yet, waiting...');
        setTimeout(() => {
          loadUtilScripts().then(resolve).catch(reject);
        }, 200);
        return;
      }

      // Load scripts one after another
      loadScript('timestamp_utils.js')
        .then(() => loadScript('storage_utils.js'))
        .then(() => {
          console.log('ModelMeter Content: Both utility scripts loaded successfully');
          resolve();
        })
        .catch(reject);
    } catch (error) {
      console.error('ModelMeter Content: Error in loadUtilScripts', error);
      reject(error);
    }
  });
}

// Helper function to load a single script
function loadScript(scriptName) {
  return new Promise((resolve, reject) => {
    try {
      // Create script element
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(scriptName);
      script.async = true;
      
      script.onload = () => {
        console.log(`ModelMeter Content: Successfully loaded ${scriptName}`);
        resolve();
      };
      
      script.onerror = (error) => {
        console.error(`ModelMeter Content: Failed to load ${scriptName}`, error);
        reject(error);
      };
      
      // Try-catch for appending
      try {
        document.head.appendChild(script);
      } catch (error) {
        console.error(`ModelMeter Content: Error appending ${scriptName} to document.head`, error);
        if (error.message && error.message.includes('Extension context invalidated')) {
          handleExtensionContextError(`loadScript-${scriptName}`);
        }
        reject(error);
      }
    } catch (error) {
      console.error(`ModelMeter Content: Error setting up ${scriptName}`, error);
      reject(error);
    }
  });
}

// Initialize the extension
async function initialize() {
  if (isModelMeterInitialized) {
    console.log('ModelMeter Content: Already initialized, skipping.');
    return;
  }
  
  try {
    // Load utility scripts first
    await loadUtilScripts();
    
    // First create UI elements
    createTestElement();
    createBubbleUI();
    createInPageUI();
    
    // Then set up all listeners and observers
    setupMessageListeners();
    setupVisibilityChangeDetection();
    setupFetchInterception();
    setupOutsideClickHandler();
    
    // Finally, start model detection and mark as initialized
    isModelMeterInitialized = true;
    startModelDetection();
    
    // Initial UI update with a slight delay to ensure everything is ready
    setTimeout(() => {
      detectCurrentModel();
      updateUI().catch(error => {
        console.error('ModelMeter Content: Initial UI update failed:', error);
        if (error.message && error.message.includes('Extension context invalidated')) {
          handleExtensionContextError('initialUIUpdate');
        }
      });
      
      // Check for banners and reset expired model counters
      checkAndParseRateLimitBanner();
      checkAndResetExpiredModels();
      
      // Set up multiple timer intervals for different purposes
      
      // 1. MAIN TIMER: Every 60 seconds - Full check (expiration, banners, health)
      setInterval(() => {
        console.log('ModelMeter: Running 60-second comprehensive check...');
        checkAndParseRateLimitBanner();
        checkAndResetExpiredModels();
        performHealthCheck();
        
        // Always try to update UI, even if background communication fails
        updateUI().catch(error => {
          console.error('ModelMeter: UI update failed in 60s timer:', error);
        });
      }, 60000);
      
      // 2. BACKGROUND HEALTH TIMER: Every 30 seconds - Quick ping test
      setInterval(() => {
        console.log('ModelMeter: Running 30-second background health check...');
        safeSendMessage({ action: 'ping' }, { suppressErrors: true }).then(response => {
          if (!response) {
            console.warn('ModelMeter: Background script not responding in 30s health check');
            showReloadPageMessage('ModelMeter background script stopped responding. Please refresh the page to restore functionality.');
          } else {
            console.log('ModelMeter: Background script healthy in 30s check');
          }
        }).catch(error => {
          console.error('ModelMeter: Background health check error:', error);
          showReloadPageMessage('ModelMeter background script communication error. Please refresh the page to restore functionality.');
        });
      }, 30000);
      
      // 3. UI UPDATE TIMER: Every 15 seconds - Keep UI fresh
      setInterval(() => {
        console.log('ModelMeter: Running 15-second UI refresh...');
        detectCurrentModel();
        updateUI().catch(error => {
          console.error('ModelMeter: UI refresh failed in 15s timer:', error);
        });
      }, 15000);
      
      // 4. CRITICAL EXPIRATION TIMER: Every 2 minutes - Independent expiration check
      setInterval(() => {
        console.log('ModelMeter: Running 2-minute critical expiration check...');
        checkAndResetExpiredModels().catch(error => {
          console.error('ModelMeter: Critical expiration check failed:', error);
        });
      }, 120000);
      
      // Perform initial health check after 5 seconds
      setTimeout(() => {
        performHealthCheck();
      }, 5000);
      
      // Perform initial background health check after 10 seconds
      setTimeout(() => {
        safeSendMessage({ action: 'ping' }, { suppressErrors: true }).then(response => {
          if (!response) {
            console.warn('ModelMeter: Initial background script health check failed');
            showReloadPageMessage('ModelMeter background script not responding on startup. Please refresh the page to restore functionality.');
          } else {
            console.log('ModelMeter: Initial background script health check passed');
          }
        });
      }, 10000);
    }, 1000);
    
    console.log('ModelMeter Content: Initialized successfully');
  } catch (error) {
    console.error('ModelMeter Content: Initialization failed', error);
    isModelMeterInitialized = false;
    if (error.message && error.message.includes('Extension context invalidated')) {
      handleExtensionContextError('initialize');
    } else {
      // Show reload message for initialization failures
      showReloadPageMessage('ModelMeter failed to initialize properly. Please refresh the page to restore functionality.');
    }
  }
}

// Health check function to detect if extension is working properly
async function performHealthCheck() {
  try {
    // Skip health checks if we already know context is invalid
    if (!extensionContextValid) {
      return;
    }
    
    // Skip if reload message is already shown
    if (reloadMessageShown) {
      return;
    }
    
    // Test if we can communicate with the background script
    const healthResponse = await safeSendMessage({ action: 'healthCheck' }, { suppressErrors: true });
    
    if (!healthResponse) {
      console.warn('ModelMeter Content: Health check failed - no response from background script');
      showReloadPageMessage('ModelMeter appears to be disconnected. Please refresh the page to restore functionality.');
      return;
    }
    
    // Check if UI elements are still present and functional
    if (isModelMeterInitialized && !bubbleElement) {
      console.warn('ModelMeter Content: Health check failed - bubble element missing');
      showReloadPageMessage('ModelMeter UI elements are missing. Please refresh the page to restore functionality.');
      return;
    }
    
    // Check if we can still access extension resources
    try {
      chrome.runtime.getURL('manifest.json');
    } catch (error) {
      console.warn('ModelMeter Content: Health check failed - cannot access extension resources');
      extensionContextValid = false;
      showReloadPageMessage('ModelMeter extension resources are inaccessible. Please refresh the page to restore functionality.');
      return;
    }
    
    console.log('ModelMeter Content: Health check passed');
  } catch (error) {
    console.error('ModelMeter Content: Health check error:', error);
    if (error.message && error.message.includes('Extension context invalidated')) {
      extensionContextValid = false;
      handleExtensionContextError('healthCheck');
    } else {
      showReloadPageMessage('ModelMeter health check failed. Please refresh the page to restore functionality.');
    }
  }
}

// Set up interception of network requests to monitor API calls
function setupFetchInterception() {
  try {
    console.log('ModelMeter Debug: 🚧 Setting up multiple API interception methods...');
    
    // METHOD 1: Override fetch API
    setupFetchOverride();
    
    // METHOD 2: Override XMLHttpRequest
    setupXhrOverride();
    
    // METHOD 3: Use PerformanceObserver
    setupPerformanceObserver();
    
    console.log('ModelMeter Debug: 🚀 Multiple API interception methods set up successfully');
  } catch (error) {
    console.error('ModelMeter Debug: ❌ Failed to set up API interceptions:', error);
  }
}

// METHOD 1: Override fetch API
function setupFetchOverride() {
  try {
    originalFetch = window.fetch;
    if (!originalFetch) {
      console.error("ModelMeter Debug: ⚠️ window.fetch is undefined! Can't intercept fetch.");
      return;
    }
    
    window.fetch = async function(...args) {
      const resource = args[0];
      const options = args[1] || {};
      const url = resource instanceof Request ? resource.url : String(resource);
      console.log(`ModelMeter Debug: 🔎 Fetch called for URL: ${url}`); // Keep basic log

      // Request body processing (keep this if still useful for other debugging or future use)
      try {
        if (API_ENDPOINTS.some(endpoint => url.startsWith(endpoint))) {
          console.log(`ModelMeter Debug: 🔍 API Request Detected (by original override) -> ${url}`);
          let bodyContent = null;
          let requestBody = null;
          if (resource instanceof Request && resource.body) {
            try {
              const clonedRequest = resource.clone();
              const text = await clonedRequest.text();
              bodyContent = text;
              try { requestBody = JSON.parse(text); } catch(e) { console.warn('ModelMeter Debug: ⚠️ Failed to parse Request body JSON (original override):', e); }
            } catch(e) { console.error('ModelMeter Debug: ❌ Error reading Request body (original override):', e); }
          }
          if (!requestBody && options && options.body) {
            bodyContent = typeof options.body === 'string' ? options.body : 
                          options.body instanceof URLSearchParams ? options.body.toString() : null;          
            if (bodyContent) {
              try { requestBody = JSON.parse(bodyContent); } catch(e) { console.warn('ModelMeter Debug: ⚠️ Failed to parse options body JSON (original override):', e); }
            }
          }
          if (requestBody) {
            // console.log('ModelMeter Debug: 📄 Request Body (original override):', requestBody); // Can be verbose
            handleApiRequest(url, requestBody); // This sends model info to background for logging
          }
        }
      } catch (e) {
        console.error('ModelMeter Debug: ❌ Error in fetch override request handling (original override):', e);
      }
      
      // Execute and return the original fetch request promise
      // NO LONGER ATTEMPTING TO PROCESS RESPONSE STREAM HERE
      return originalFetch.apply(this, args);
    };
    
    console.log('ModelMeter Debug: ✅ Original Fetch override (request logging only) installed.');
  } catch (error) {
    console.error('ModelMeter Debug: ❌ Failed to set up original fetch override:', error);
    if (originalFetch) window.fetch = originalFetch; // Restore on error
  }
}

// METHOD 2: Override XMLHttpRequest
function setupXhrOverride() {
  try {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      // Store the URL for later use in send
      this._mmUrl = url;
      this._mmMethod = method;
      return originalOpen.apply(this, [method, url, ...rest]);
    };
    
    XMLHttpRequest.prototype.send = function(body) {
      const url = this._mmUrl;
      
      try {
        if (typeof url === 'string' && API_ENDPOINTS.some(endpoint => url.startsWith(endpoint))) {
          console.log(`ModelMeter Debug: 🔍 XHR Request Detected -> ${this._mmMethod} ${url}`);
          
          if (body) {
            let requestBody;
            try {
              if (typeof body === 'string') {
                requestBody = JSON.parse(body);
                console.log('ModelMeter Debug: 📄 XHR Request Body:', requestBody);
                handleApiRequest(url, requestBody);
              }
            } catch (e) {
              console.error('ModelMeter Debug: ❌ Error parsing XHR body:', e);
            }
          }
          
          // Listen for response to get model used
          this.addEventListener('load', function() {
            try {
              if (this.responseType === '' || this.responseType === 'text') {
                const responseText = this.responseText;
                if (responseText) {
                  try {
                    const response = JSON.parse(responseText);
                    if (response && response.model) {
                      console.log(`ModelMeter Debug: 📡 XHR Response contains model: ${response.model}`);
                      // Update model from response if needed
                    }
                  } catch (e) {
                    // Not JSON or no model in response, ignore
                  }
                }
              }
            } catch (e) {
              console.error('ModelMeter Debug: ❌ Error processing XHR response:', e);
            }
          });
        }
      } catch (e) {
        console.error('ModelMeter Debug: ❌ Error in XHR send override:', e);
      }
      
      return originalSend.apply(this, arguments);
    };
    
    console.log('ModelMeter Debug: ✅ XMLHttpRequest override installed successfully');
  } catch (error) {
    console.error('ModelMeter Debug: ❌ Failed to set up XHR override:', error);
  }
}

// METHOD 3: Use PerformanceObserver
function setupPerformanceObserver() {
  try {
    if (!PerformanceObserver) {
      console.error('ModelMeter Debug: ⚠️ PerformanceObserver not supported in this browser');
      return;
    }
    
    // Create an observer instance linked to a callback function
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach(entry => {
        try {
          if (entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest') {
            const url = entry.name;
            
            if (typeof url === 'string' && API_ENDPOINTS.some(endpoint => url.startsWith(endpoint))) {
              console.log(`ModelMeter Debug: 🔍 Performance Entry Detected -> ${entry.initiatorType} request to ${url}`);
              
              // Check if this is an actual conversation endpoint (meaning a message was sent)
              // Explicitly exclude preparation endpoints and ensure we're targeting the main conversation endpoint
              const isExactConversationEndpoint = 
                url.endsWith('/backend-api/f/conversation') || 
                url.endsWith('/backend-api/conversation');

              if (isExactConversationEndpoint && !url.includes('/prepare')) { // Keep /prepare exclusion as a safeguard
                console.log(`ModelMeter Debug: 🎯 Exact conversation API call detected via PerformanceObserver: ${url}`);
                
                // Create a timer to check regularly if the response has completed
                let waitCount = 0;
                const checkForCompletion = () => {
                  waitCount++;
                  console.log(`ModelMeter Debug: ⏱️ Checking for completed response (attempt ${waitCount})`);
                  
                  // First check if we can detect the model from DOM
                  const modelUpdated = detectCurrentModel();
                  console.log(`ModelMeter Debug: 🔄 Model detection result: ${modelUpdated ? 'Updated' : 'Unchanged'}, current model: ${currentModel || 'Unknown'}`);
                  
                  // Check if we have what we need to increment
                  if (currentModel) {
                    const conversationId = `perf_obs_${Date.now()}`; // Generate a pseudo-ID for tracking
                    console.log(`ModelMeter Debug: ➕ Incrementing counter for detected model: ${currentModel} (ID: ${conversationId})`);
                    
                    // Only increment if we haven't already processed this in the last few seconds
                    const now = Date.now();
                    const recentIncrements = Array.from(processedMessageIds)
                      .filter(id => id.startsWith('perf_obs_'))
                      .map(id => parseInt(id.split('_')[2]));
                    
                    const mostRecentIncrement = recentIncrements.length > 0 ? 
                      Math.max(...recentIncrements) : 0;
                    
                    if (now - mostRecentIncrement > 5000) { // At least 5 seconds since last increment
                      incrementCounterInBackground(currentModel, conversationId);
                      processedMessageIds.add(conversationId);
                      
                      // Update all UI components together using our helper
                      updateAllUIComponents();
                      
                      return true; // Success - we're done
                    } else {
                      console.log(`ModelMeter Debug: 🚫 Skipping increment because another was triggered recently (${(now - mostRecentIncrement)/1000}s ago)`);
                      return true; // Consider this a success case too
                    }
                  }
                  
                  // If we don't have the model yet but haven't tried too many times, try again
                  if (waitCount < 10) { // Try up to 10 times (with 1s between = up to 10s total)
                    console.log(`ModelMeter Debug: ⏳ Model not yet available, will check again in 1s...`);
                    setTimeout(checkForCompletion, 1000); // Check again in 1 second
                    return false; // Not complete yet
                  } else {
                    console.log(`ModelMeter Debug: ❌ Gave up waiting for model after ${waitCount} attempts`);
                    return true; // Give up
                  }
                };
                
                // Start the checking process
                console.log(`ModelMeter Debug: ⏱️ Starting to check for completed response`);
                setTimeout(checkForCompletion, 1000); // Start checking after 1s
              } else {
                // This is a non-conversation endpoint, a prepare endpoint, or a conversation sub-path
                console.log(`ModelMeter Debug: 🔍 Non-incrementable or sub-path endpoint detected: ${url}. Updating model info only.`);
                setTimeout(() => {
                  detectCurrentModel();
                  updateUI();
                }, 1000);
              }
            }
          }
        } catch (e) {
          console.error('ModelMeter Debug: ❌ Error processing performance entry:', e);
        }
      });
    });
    
    // Start observing resource timing entries
    observer.observe({ entryTypes: ['resource'] });
    console.log('ModelMeter Debug: ✅ PerformanceObserver set up successfully (with enhanced increment logic)');
  } catch (error) {
    console.error('ModelMeter Debug: ❌ Failed to set up PerformanceObserver:', error);
  }
}

// Helper function to send increment message to background
function incrementCounterInBackground(modelSlug, messageId) {
   console.log(`ModelMeter Content: Sending increment request for model: ${modelSlug}, messageId: ${messageId}`);
   
   safeSendMessage({
       action: 'incrementModelCount',
       modelFullName: modelSlug // background expects modelFullName
   }, { suppressErrors: true }).then(response => {
       if (response && response.status === 'success') {
           console.log(`ModelMeter Content: Background confirmed increment for model: ${modelSlug}`);
           // Immediately update all UI components to keep in sync
           updateAllUIComponents();
       } else {
           console.log(`ModelMeter Content: Background failed increment for ${modelSlug}`, response);
       }
   }).catch(err => {
       console.error(`ModelMeter Content: Error sending increment for ${modelSlug} to background:`, err);
   });
}

// New helper function to update all UI components in one go
function updateAllUIComponents() {
    console.log('ModelMeter Content: Updating all UI components for consistency');
    updateUI(); // Update bubble
    if (inPagePanel && inPagePanel.style.display === 'block') {
        updateInPagePanelData(); // Update panel if visible
    }
    console.log('ModelMeter Debug: 🛡️ Checking for rate limit banner after UI update...');
    checkAndParseRateLimitBanner();
}

// Unified handler for API requests
function handleApiRequest(url, requestData) {
  try {
    if (!requestData || !requestData.model) {
      console.log('ModelMeter Debug: ⚠️ No model found in request data');
      return;
    }
    
    let modelToTrack = requestData.model;
    const actionType = requestData.action || 'unknown';
    
    console.log(`ModelMeter Debug: 🤖 API Request - Model: ${modelToTrack}, Action: ${actionType}`);
    
    // If model is "auto", check the last message for actual model used
    if (modelToTrack.toLowerCase() === 'auto') {
      console.log('ModelMeter Debug: 🔄 "Auto" model detected, looking for actual model...');
      const assistantMessages = document.querySelectorAll('div[data-message-author-role="assistant"][data-message-id]');
      if (assistantMessages.length > 0) {
        const lastMessage = assistantMessages[assistantMessageContents.length - 1];
        const actualModel = lastMessage.getAttribute('data-message-model-slug');
        if (actualModel) {
          console.log(`ModelMeter Debug: ✨ "Auto" resolved to actual model: ${actualModel}`);
          modelToTrack = actualModel;
        }
      }
    }
    
    // Send to background script for counting
    chrome.runtime.sendMessage({
      action: 'apiRequestDetected',
      modelData: {
        model: modelToTrack,
        action: actionType,
        url: url
      }
    }).then(response => {
      console.log('ModelMeter Debug: ✅ Background script response:', response);
    }).catch(err => {
      console.error('ModelMeter Debug: ❌ Error sending API data to background:', err);
    });
    
    // Update current model
    if (modelToTrack !== currentModel) {
      console.log(`ModelMeter Debug: 🔄 Updating currentModel from ${currentModel} to ${modelToTrack}`);
      currentModel = modelToTrack;
      updateUI();
    }
  } catch (error) {
    console.error('ModelMeter Debug: ❌ Error handling API request:', error);
  }
}

// Debug function to test API interception
function testApiInterception() {
  console.log('ModelMeter Debug: 🧪 Testing multiple API interception methods...');
  
  // Test model
  const testModel = currentModel || 'gpt-4o';
  
  // Test data
  const testData = {
    model: testModel,
    action: 'next',
    messages: [{ role: 'user', content: 'Test message' }]
  };
  
  // Method 1: Test fetch
  console.log('ModelMeter Debug: 🧪 Testing fetch interception...');
  fetch('https://chatgpt.com/backend-api/f/conversation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testData)
  }).catch(() => {});
  
  // Method 2: Test XHR
  console.log('ModelMeter Debug: 🧪 Testing XMLHttpRequest interception...');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', 'https://chatgpt.com/backend-api/f/conversation');
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send(JSON.stringify(testData));
  
  // Method 3: Direct test
  console.log('ModelMeter Debug: 🧪 Testing direct message to background...');
  chrome.runtime.sendMessage({
    action: 'apiRequestDetected',
    modelData: {
      model: testModel,
      action: 'next',
      url: 'https://chatgpt.com/backend-api/f/conversation'
    }
  }).then(response => {
    console.log('ModelMeter Debug: 🧪 Direct message response:', response);
  }).catch(error => {
    console.error('ModelMeter Debug: 🧪 Direct message error:', error);
  });
}

// Create a visible test element
function createTestElement() {
  try {
    const existingTestElement = document.getElementById('modelmeter-test-element');
    if (existingTestElement) existingTestElement.remove();

    const testElement = document.createElement('div');
    testElement.id = 'modelmeter-test-element';
    testElement.style.position = 'fixed';
    testElement.style.top = '100px';
    testElement.style.right = '20px';
    testElement.style.padding = '10px';
    testElement.style.background = 'red';
    testElement.style.color = 'white';
    testElement.style.zIndex = '9999999';
    testElement.style.borderRadius = '5px';
    testElement.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';
    testElement.innerText = 'ModelMeter Active (Content Script Running)';
    
    document.body.appendChild(testElement);
    console.log('ModelMeter: Test element created and added to DOM');
    
    setTimeout(() => {
      if (testElement && testElement.parentNode) {
      testElement.remove();
      }
    }, 15000); // Increased visibility to 15 seconds
  } catch (error) {
    console.error('ModelMeter: Failed to create test element', error);
  }
}

// Create the bubble
function createBubbleUI() {
  if (document.getElementById('modelmeter-bubble')) return;

    bubbleElement = document.createElement('div');
    bubbleElement.id = 'modelmeter-bubble';
  bubbleElement.textContent = 'ModelMeter'; // Will be updated by updateUI
    bubbleElement.style.cssText = `
    position: fixed; bottom: 80px; right: 20px; padding: 10px 15px;
    background-color: #0078D7; color: white; border-radius: 20px;
    font-family: system-ui, sans-serif; font-weight: bold; font-size: 14px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); z-index: 2147483646;
    cursor: pointer; border: 2px solid white;
  `;
  // Add a double-click handler for testing API interception
  bubbleElement.addEventListener('dblclick', () => {
    testApiInterception();
  });
  document.body.appendChild(bubbleElement);
  panelToggleButton = bubbleElement;

  panelToggleButton.addEventListener('click', () => {
    if (inPagePanel) {
      const  isVisible = inPagePanel.style.display === 'block';
      inPagePanel.style.display = isVisible ? 'none' : 'block';
      if (!isVisible) {
        updateInPagePanelData();
      }
    }
  });
  uiInitialized = true;
  updateUI();
  console.log('ModelMeter Content: Bubble UI created');
}

// Create the In-Page UI Panel
function createInPageUI() {
  if (document.getElementById('modelmeter-inpage-panel')) return;

  inPagePanel = document.createElement('div');
  inPagePanel.id = 'modelmeter-inpage-panel';
  inPagePanel.style.cssText = `
    position: fixed; bottom: 130px; right: 20px;
    width: 380px; background-color: white; border: 1px solid #ccc; border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 2147483645;
    padding: 15px; font-family: Arial, sans-serif; color: #333; display: none;
    font-size: 14px;
  `;
  
  // --- NEW: HTML for User Plan Selection --- 
  const planSelectionHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; padding-bottom:10px; border-bottom:1px solid #eee;">
      <span style="font-weight:bold;">User Plan:</span>
      <div class="modelmeter-plan-selection-container" style="display:flex; align-items:center; gap: 8px;">
        <span id="user-plan-label-free" class="plan-label" style="cursor:pointer; padding: 6px 12px; border-radius: 20px; border: 1px solid #dee2e6; background-color: #f8f9fa;">Free</span>
        <span id="user-plan-label-plus" class="plan-label" style="cursor:pointer; padding: 6px 12px; border-radius: 20px; border: 1px solid #dee2e6; background-color: #f8f9fa;">Plus</span>
      </div>
    </div>
  `;
  // --- END NEW ---

  inPagePanel.innerHTML = `
    <h3 style="margin-top:0; margin-bottom:10px; font-size:16px; border-bottom:1px solid #eee; padding-bottom:5px;">ModelMeter Details</h3>
    ${planSelectionHTML} 
    <div id="inpage-status" style="font-style:italic; font-size:12px; margin-bottom:10px;">Loading...</div>
    <div id="inpage-counters-title" style="font-weight:bold; margin-bottom:5px;">Message Counts:</div>
    <div id="inpage-counters" style="font-size:12px;">
      <div class="no-data">Loading counts...</div>
    </div>
  `;
  document.body.appendChild(inPagePanel);
  console.log('ModelMeter Content: In-page panel UI created with plan selection labels');

  // Create the configuration modal
  createConfigModal();

  // --- NEW: Event Listeners for User Plan Labels ---
  const planLabelFree = inPagePanel.querySelector('#user-plan-label-free');
  const planLabelPlus = inPagePanel.querySelector('#user-plan-label-plus');

  async function handlePlanSelection(selectedPlan) {
    console.log(`ModelMeter Content: User plan label clicked: ${selectedPlan}`);
    try {
      await chrome.runtime.sendMessage({ action: 'setUserPlan', plan: selectedPlan });
      // Update styles immediately for responsiveness
      updatePlanLabelStyles(selectedPlan);
      // Optionally, refresh other panel data if needed
      // updateInPagePanelData(); 
    } catch (e) {
      console.error('ModelMeter Content: Error setting user plan', e);
      updateStatusInPanel(`Error setting plan to ${selectedPlan}.`, 'error', 'inpage-status');
      if (e.message && e.message.includes('Extension context invalidated')) {
        handleExtensionContextError('setUserPlanInPageLabels');
      }
      // Revert styles on error by re-fetching the actual current plan
      updateInPagePanelData(); 
    }
  }

  if (planLabelFree) {
    planLabelFree.addEventListener('click', () => {
      handlePlanSelection('FREE').then(() => {
        // Refresh panel data after plan change
        updateInPagePanelData();
      });
    });
  }
  if (planLabelPlus) {
    planLabelPlus.addEventListener('click', () => {
      handlePlanSelection('PLUS').then(() => {
        // Refresh panel data after plan change
        updateInPagePanelData();
      });
    });
  }
  // --- END NEW ---
}

// Create configuration modal for in-page usage
function createConfigModal() {
  if (document.getElementById('modelmeter-config-modal')) return;
  
  const configModal = document.createElement('div');
  configModal.id = 'modelmeter-config-modal';
  configModal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0,0,0,0.5);
    z-index: 2147483646;
    display: none;
    justify-content: center;
    align-items: center;
  `;
  
  configModal.innerHTML = `
    <div class="config-modal-content" style="
      background-color: white;
      padding: 20px;
      border-radius: 6px;
      width: 90%;
      max-width: 300px;
      box-shadow: 0 4px 8px rgba(0,0,0,0.2);
    ">
      <div class="modal-title" style="
        font-size: 16px;
        font-weight: bold;
        margin-bottom: 15px;
        color: #333;
      ">Configure Model</div>
      <form id="inpage-config-form">
        <input type="hidden" id="inpage-config-model-name" name="modelName">
        <div class="form-group" style="margin-bottom: 15px;">
          <label for="inpage-config-count" style="
            display: block;
            margin-bottom: 5px;
            font-weight: 500;
            color: #333;
          ">Message Count:</label>
          <input type="number" id="inpage-config-count" name="count" min="0" required style="
            width: 100%;
            padding: 8px;
            border: 1px solid #ddd;
            border-radius: 4px;
            color: #333;
          ">
        </div>
        <div class="form-group" style="margin-bottom: 15px;">
          <label for="inpage-config-expire-date" style="
            display: block;
            margin-bottom: 5px;
            font-weight: 500;
            color: #333;
          ">Expiration Date:</label>
          <input type="datetime-local" id="inpage-config-expire-date" name="expireDate" required style="
            width: 100%;
            padding: 8px;
            border: 1px solid #ddd;
            border-radius: 4px;
            color: #333;
          ">
        </div>
        <div class="form-actions" style="
          display: flex;
          justify-content: space-between;
          margin-top: 20px;
        ">
          <button type="button" id="inpage-cancel-config" style="
            background: #6c757d;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 500;
            transition: background 0.2s;
          ">Cancel</button>
          <button type="submit" id="inpage-save-config" style="
            background: #28a745;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 500;
            transition: background 0.2s;
          ">Save</button>
        </div>
      </form>
    </div>
  `;
  
  document.body.appendChild(configModal);
  
  // Add event listeners for the modal
  document.getElementById('inpage-cancel-config')?.addEventListener('click', function() {
    hideConfigModal();
  });
  
  document.getElementById('inpage-config-form')?.addEventListener('submit', function(event) {
    event.preventDefault();
    saveModelConfig();
  });
  
  // Add keyboard support for ESC key to close the modal
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape' || event.keyCode === 27) {
      const configModal = document.getElementById('modelmeter-config-modal');
      if (configModal && configModal.style.display === 'flex') {
        console.log('ModelMeter Content: ESC key pressed, hiding config modal');
        configModal.style.display = 'none';
      }
    }
  });
  
  console.log('ModelMeter Content: Configuration modal created with keyboard support');

  // Add CSS to ensure input icons are visible in config modal
  const iconStyles = document.createElement('style');
  iconStyles.type = 'text/css';
  iconStyles.textContent = `
    /* Darken spinner arrows and calendar icon in in-page config modal */
    #modelmeter-config-modal input::-webkit-inner-spin-button,
    #modelmeter-config-modal input::-webkit-outer-spin-button {
      filter: invert(1) !important;
    }
    #modelmeter-config-modal input::-webkit-calendar-picker-indicator {
      filter: invert(1) !important;
    }
  `;
  document.head.appendChild(iconStyles);
}

// Show the configuration modal with model data
function showConfigModal(modelName, modelData) {
  console.log('ModelMeter Content: Opening configuration for model:', modelName, modelData);
  
  // Set the model name in the hidden field
  document.getElementById('inpage-config-model-name').value = modelName;
  
  // Set the current count
  document.getElementById('inpage-config-count').value = modelData.count || 0;
  
  // Use the existing expiration date (until) from model data - prefer nextResetTime, fallback to limitResetTime
  let expireDate;
  const existingResetTime = modelData.nextResetTime || modelData.limitResetTime;
  
  if (existingResetTime) {
    expireDate = new Date(existingResetTime);
    console.log(`ModelMeter Content: Using existing reset time for ${modelName}: ${expireDate.toISOString()}`);
  } else {
    // Only if no reset time exists at all, use a future date (1 day from now)
    expireDate = new Date();
    expireDate.setDate(expireDate.getDate() + 1);
    console.log(`ModelMeter Content: No existing reset time for ${modelName}, defaulting to 1 day from now: ${expireDate.toISOString()}`);
  }
  
  // Format date to yyyy-MM-ddThh:mm in LOCAL timezone (not UTC)
  const year = expireDate.getFullYear();
  const month = String(expireDate.getMonth() + 1).padStart(2, '0');
  const day = String(expireDate.getDate()).padStart(2, '0');
  const hours = String(expireDate.getHours()).padStart(2, '0');
  const minutes = String(expireDate.getMinutes()).padStart(2, '0');
  const formattedDate = `${year}-${month}-${day}T${hours}:${minutes}`;
  
  document.getElementById('inpage-config-expire-date').value = formattedDate;
  
  // Show the modal
  const configModal = document.getElementById('modelmeter-config-modal');
  if (configModal) {
    configModal.style.display = 'flex';
  }
}

// Hide the configuration modal
function hideConfigModal() {
  const configModal = document.getElementById('modelmeter-config-modal');
  if (configModal) {
    configModal.style.display = 'none';
  }
}

// Save the model configuration
async function saveModelConfig() {
  const modelName = document.getElementById('inpage-config-model-name').value;
  const count = parseInt(document.getElementById('inpage-config-count').value);
  const expireDate = new Date(document.getElementById('inpage-config-expire-date').value).getTime();
  
  if (!modelName || isNaN(count) || isNaN(expireDate)) {
    updateStatusInPanel('Invalid configuration data.', 'error', 'inpage-status');
    return;
  }

  try {
    // Get current model data
    const response = await chrome.runtime.sendMessage({ action: 'getModelData' });
    if (!response || response.status !== 'success' || !response.data) {
      updateStatusInPanel('Failed to get model data for configuration.', 'error', 'inpage-status');
      return;
    }

    const modelData = response.data;
    if (!modelData[modelName]) {
      updateStatusInPanel(`Model ${modelName} not found.`, 'error', 'inpage-status');
      return;
    }

    // Get model limit information to calculate the since date based on until date
    const planResponse = await chrome.runtime.sendMessage({ action: 'getUserPlan' });
    const userPlan = (planResponse && planResponse.status === 'success') ? planResponse.plan : 'FREE';
    
    // Request update with the new configuration
    const updateResponse = await chrome.runtime.sendMessage({
      action: 'updateModelConfig',
      modelName: modelName,
      count: count,
      untilTimestamp: expireDate,
      userPlan: userPlan
    });

    if (updateResponse && updateResponse.status === 'success') {
      updateStatusInPanel(`Configuration for ${modelName} updated.`, 'success', 'inpage-status');
      hideConfigModal();
      updateInPagePanelData();
    } else {
      updateStatusInPanel(`Failed to update configuration for ${modelName}.`, 'error', 'inpage-status');
    }
  } catch (error) {
    updateStatusInPanel(`Error saving configuration: ${error.message}`, 'error', 'inpage-status');
    console.error('ModelMeter Content: Error saving model configuration:', error);
    if (error.message && error.message.includes('Extension context invalidated')) {
      handleExtensionContextError('saveModelConfig');
    }
  }
}

// Make sure updatePlanLabelStyles and updateInPagePanelData are completely clean of any references
function updatePlanLabelStyles(activePlan) {
  if (!inPagePanel) return;
  
  const planLabelFree = inPagePanel.querySelector('#user-plan-label-free');
  const planLabelPlus = inPagePanel.querySelector('#user-plan-label-plus');

  if (!planLabelFree || !planLabelPlus) return;

  // Reset styles first 
  planLabelFree.classList.remove('plan-label-selected');
  planLabelPlus.classList.remove('plan-label-selected');
  planLabelFree.style.fontWeight = 'normal';
  planLabelPlus.style.fontWeight = 'normal';
  planLabelFree.style.color = '#6c757d'; 
  planLabelPlus.style.color = '#6c757d';
  planLabelFree.style.backgroundColor = '#f8f9fa';
  planLabelPlus.style.backgroundColor = '#f8f9fa';
  
  // Apply active styles
  if (activePlan === 'FREE') {
    planLabelFree.classList.add('plan-label-selected');
    planLabelFree.style.fontWeight = 'bold';
    planLabelFree.style.color = 'white';
    planLabelFree.style.backgroundColor = '#007bff'; 
    planLabelFree.style.borderColor = '#007bff';
  } else if (activePlan === 'PLUS') {
    planLabelPlus.classList.add('plan-label-selected');
    planLabelPlus.style.fontWeight = 'bold';
    planLabelPlus.style.color = 'white';
    planLabelPlus.style.backgroundColor = '#28a745'; 
    planLabelPlus.style.borderColor = '#28a745';
  }
}

// Update the data within the In-Page Panel
async function updateInPagePanelData() {
  if (!inPagePanel || inPagePanel.style.display === 'none') return;

  const statusEl = inPagePanel.querySelector('#inpage-status');
  const countersEl = inPagePanel.querySelector('#inpage-counters');
  // --- REMOVED: Get plan switch elements (planToggle, slider) ---
  // const planToggle = ...
  // const slider = ...
  // --- Get label elements directly ---
  const planLabelFree = inPagePanel.querySelector('#user-plan-label-free');
  const planLabelPlus = inPagePanel.querySelector('#user-plan-label-plus');
  // --- END Changes ---

  if (!statusEl || !countersEl || !planLabelFree || !planLabelPlus) return; // Adjusted check

  // Display raw currentModel
  statusEl.textContent = `Current model: ${currentModel || 'Unknown'}`;
  countersEl.innerHTML = '<div class="no-data">Loading counts...</div>';

  try {
    // --- MODIFIED: Fetch and set user plan styles ---
    const planResponse = await chrome.runtime.sendMessage({ action: 'getUserPlan' });
    let currentPlan = 'FREE'; // Default to FREE if not fetched
    if (planResponse && planResponse.status === 'success') {
      currentPlan = planResponse.plan;
      console.log(`ModelMeter Content: Current user plan from storage: ${currentPlan}`);
      updatePlanLabelStyles(currentPlan); // Use helper function to set styles
    } else {
      console.warn('ModelMeter Content: Failed to get user plan for panel. Defaulting to FREE.');
      updatePlanLabelStyles('FREE');
    }
    // --- END MODIFIED ---

    // Define model limits based on the current plan
    let modelLimits = {};
    
              // Set model limits based on the plan with structured data
     if (currentPlan === 'FREE') {
       modelLimits = {
          'gpt-4o': { count: 10, periodAmount: 2, periodUnit: 'hour', displayText: '~15 per 3h' },
          'gpt-4o-mini': { count: Infinity, periodAmount: 0, periodUnit: 'unlimited', displayText: 'Unlimited' },
          'o3-mini': { count: 0, periodAmount: 0, periodUnit: 'none', displayText: '0' },
          'o4-mini': { count: 20, periodAmount: 5, periodUnit: 'hour', displayText: '~20 per 5h' },
          'o4-mini-high': { count: 0, periodAmount: 0, periodUnit: 'none', displayText: '0' },
          'deep-research-lite': { count: 5, periodAmount: 1, periodUnit: 'month', displayText: '5 per month' },
          'dall-e-3': { count: 3, periodAmount: 1, periodUnit: 'day', displayText: '3 per day' }
       };
     } else if (currentPlan === 'PLUS') {
       modelLimits = {
          'gpt-4': { count: 40, periodAmount: 3, periodUnit: 'hour', displayText: '40 per 3h' },
          'gpt-4o': { count: 80, periodAmount: 3, periodUnit: 'hour', displayText: '80 per 3h' },
          'o3': { count: 100, periodAmount: 1, periodUnit: 'week', displayText: '100 per week' },
          'o3-mini': { count: 50, periodAmount: 1, periodUnit: 'week', displayText: '50 per week' },
          'o4-mini': { count: 300, periodAmount: 1, periodUnit: 'day', displayText: '150 per day' },
          'o4-mini-high': { count: 100, periodAmount: 1, periodUnit: 'day', displayText: '50 per day' },
          'deep-research': { count: 10, periodAmount: 1, periodUnit: 'month', displayText: '10 per month' },
          'dall-e-3': { count: 40, periodAmount: 3, periodUnit: 'hour', displayText: '40 per 3h' }
       };
     }
    
    console.log(`ModelMeter Content: Using hardcoded limits for plan ${currentPlan}:`, modelLimits);
    
    // Debug info to log all model names we're encountering
    const debugResponse = await chrome.runtime.sendMessage({ action: 'getModelData' });
    if (debugResponse && debugResponse.status === 'success' && debugResponse.data) {
      const modelKeys = Object.keys(debugResponse.data);
      console.log('ModelMeter Content: Actual model names in storage:', modelKeys);
      
      // Check which models have matching limits
      modelKeys.forEach(model => {
        if (modelLimits[model]) {
          console.log(`ModelMeter Content: Found limit for ${model}: ${modelLimits[model]}`);
        } else {
          console.log(`ModelMeter Content: ⚠️ No matching limit found for model: ${model}`);
        }
      });
    }

    const response = await chrome.runtime.sendMessage({ action: 'getModelData' });
    if (response && response.status === 'success' && response.data) {
      const modelData = response.data; // Keys are raw model names
      countersEl.innerHTML = ''; 
      const modelKeys = Object.keys(modelData);
      if (modelKeys.length === 0) {
        countersEl.innerHTML = '<div class="no-data" style="text-align:center; color:#777; padding:10px;">No usage data yet.</div>';
        return;
      }
      modelKeys.sort().forEach(modelFullName => { // modelFullName is the raw key from storage
        const item = modelData[modelFullName];
        const itemDiv = document.createElement('div');
        // Format last reset date in "DD MMM HH:MM" format for consistency
        const lastResetDate = new Date(item.lastResetTimestamp);
        const resetDateTime = `${lastResetDate.getDate()} ${lastResetDate.toLocaleString('en-US', {month: 'short'})} ${lastResetDate.getHours().toString().padStart(2, '0')}:${lastResetDate.getMinutes().toString().padStart(2, '0')}`;
        
        // Display raw model name directly
        const displayName = modelFullName;
        // Get limit text, normalizing model name to lowercase for matching
        const modelLowerCase = modelFullName.toLowerCase();
        let limitText = '';
        
        // Get the model limit object
        let limitObject = null;
        
        // Try to find limit by exact match or partial match
        if (modelLimits[modelFullName]) {
          limitObject = modelLimits[modelFullName];
        } else if (modelLimits[modelLowerCase]) {
          limitObject = modelLimits[modelLowerCase];
        } else {
          // Try to find by partial match (like "gpt-4o" matching "gpt-4o-1106-preview")
          const matchingKey = Object.keys(modelLimits).find(key => 
            modelLowerCase.includes(key.toLowerCase()) || key.toLowerCase().includes(modelLowerCase)
          );
          if (matchingKey) {
            limitObject = modelLimits[matchingKey];
            console.log(`ModelMeter Content: Found limit via partial match: ${modelFullName} -> ${matchingKey}`);
          }
        }
        
        // Extract display text from limit object
        limitText = limitObject ? limitObject.displayText : '';
        
        // Try to determine next reset time based on model limits structure
        let nextResetTime = null;
        let timeToReset = '';
        
        // Check for both possible property names
        if (item.nextResetTime || item.limitResetTime) {
          // If explicitly provided by backend or from rate limit banner
          const resetTime = item.nextResetTime || item.limitResetTime;
          const resetDate = new Date(resetTime);
          // Format date as "DD MMM HH:MM"
          nextResetTime = `${resetDate.getDate()} ${resetDate.toLocaleString('en-US', {month: 'short'})} ${resetDate.getHours().toString().padStart(2, '0')}:${resetDate.getMinutes().toString().padStart(2, '0')}`;
          
          // Calculate time remaining
          const now = new Date();
          const diffMs = resetDate - now;
          if (diffMs > 0) {
            const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
            const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
            timeToReset = `(in ${diffHrs}h ${diffMins}m)`;
          }
        } else if (limitObject && limitObject.periodUnit && item.lastResetTimestamp) {
          // Calculate next reset based on lastResetTimestamp + interval
          const lastResetDate = new Date(item.lastResetTimestamp);
          const now = new Date();
          let resetDate = new Date(lastResetDate);
          
          // Calculate next reset based on last reset + period
          switch(limitObject.periodUnit) {
            case 'hour':
              // Add hours to last reset time
              resetDate.setHours(lastResetDate.getHours() + limitObject.periodAmount);
              break;
              
            case 'day':
              // Add days to last reset time
              resetDate.setDate(lastResetDate.getDate() + limitObject.periodAmount);
              break;
              
            case 'week':
              // Add weeks to last reset time
              resetDate.setDate(lastResetDate.getDate() + (limitObject.periodAmount * 7));
              break;
              
            case 'month':
              // Add months to last reset time
              resetDate.setMonth(lastResetDate.getMonth() + limitObject.periodAmount);
              break;
              
            case 'unlimited':
            case 'none':
            default:
              // No reset time for unlimited or disabled models
              resetDate = null;
              break;
          }
          
          if (resetDate) {
            // Format date as "DD MMM HH:MM"
            nextResetTime = `${resetDate.getDate()} ${resetDate.toLocaleString('en-US', {month: 'short'})} ${resetDate.getHours().toString().padStart(2, '0')}:${resetDate.getMinutes().toString().padStart(2, '0')}`;
            
            // Calculate time remaining
            const diffMs = resetDate - now;
            if (diffMs > 0) {
              const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
              const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
              timeToReset = `(in ${diffHrs}h ${diffMins}m)`;
            }
          }
        }
        
        // Set the item layout style - optimized for 3-column layout
        itemDiv.style.cssText = 'display:flex; justify-content:space-between; align-items:flex-start; padding:8px 0; border-bottom:1px solid #f0f0f0; font-size:12px;';
        
        itemDiv.innerHTML = `
            <div style="flex-basis:120px; padding-right:10px;">
              <strong style="font-size:13px; display:block;">${displayName}</strong> 
            <div style="font-size:9px; color:#777;">Since: ${resetDateTime}</div>
          </div>
            <div style="flex-grow:1; text-align:right; padding-right:10px;">
              <span style="font-weight:bold;">${item.count} / ${limitText || '0'}</span>
              ${nextResetTime ? `<div style="font-size:9px; color:#777;">Until: ${nextResetTime} ${timeToReset}</div>` : ''}
            </div>
            <div style="width:80px; text-align:right;">
            <button class="inpage-config-btn" data-model="${modelFullName}" style="padding:2px 5px; font-size:9px; background:#17a2b8; color:white; border:none; border-radius:3px; cursor:pointer; margin-right:3px;">Config</button>
            <button class="inpage-reset-single" data-model="${modelFullName}" style="padding:2px 5px; font-size:9px; background:#dc3545; color:white; border:none; border-radius:3px; cursor:pointer;">Reset</button>
          </div>
        `;
        countersEl.appendChild(itemDiv);
        
        // Add event listener for Config button
        itemDiv.querySelector('.inpage-config-btn')?.addEventListener('click', async function() {
          const modelToConfig = this.getAttribute('data-model');
          try {
            // Get current model data
            const response = await chrome.runtime.sendMessage({ action: 'getModelData' });
            if (!response || response.status !== 'success' || !response.data) {
              updateStatusInPanel('Failed to get model data for configuration.', 'error', 'inpage-status');
              return;
            }
            
            const modelData = response.data;
            if (!modelData[modelToConfig]) {
              updateStatusInPanel(`Model ${modelToConfig} not found.`, 'error', 'inpage-status');
              return;
            }
            
            // Show configuration modal
            showConfigModal(modelToConfig, modelData[modelToConfig]);
          } catch (error) {
            console.error('ModelMeter Content: Error opening config modal:', error);
            updateStatusInPanel('Error opening configuration. Please try again.', 'error', 'inpage-status');
            if (error.message && error.message.includes('Extension context invalidated')) {
              handleExtensionContextError('configModelInPanel');
            }
          }
        });
        
        itemDiv.querySelector('.inpage-reset-single')?.addEventListener('click', async function() {
          const modelToReset = this.getAttribute('data-model'); // Raw full name
          if (modelToReset && confirm(`Reset count for ${modelToReset}?`)) { // Use raw name
            try {
              // Set current time as the reset timestamp
              const now = new Date().getTime();
              
              // Get model period to calculate next reset time
              const planResponse = await chrome.runtime.sendMessage({ action: 'getUserPlan' });
              const currentPlan = (planResponse && planResponse.status === 'success') ? planResponse.plan : 'FREE';
              
              // Determine model limits based on plan
              let modelLimits = {};
              if (currentPlan === 'FREE') {
                modelLimits = {
                  'gpt-4o': { count: 15, periodAmount: 3, periodUnit: 'hour', displayText: '~15 per 3h' },
                  'gpt-4o-mini': { count: Infinity, periodAmount: 0, periodUnit: 'unlimited', displayText: 'Unlimited' },
                  'o3-mini': { count: 0, periodAmount: 0, periodUnit: 'none', displayText: '0' },
                  'o4-mini': { count: 20, periodAmount: 5, periodUnit: 'hour', displayText: '~20 per 5h' },
                  'o4-mini-high': { count: 0, periodAmount: 0, periodUnit: 'none', displayText: '0' },
                  'deep-research-lite': { count: 5, periodAmount: 1, periodUnit: 'month', displayText: '5 per month' },
                  'dall-e-3': { count: 3, periodAmount: 1, periodUnit: 'day', displayText: '3 per day' }
                };
              } else if (currentPlan === 'PLUS') {
                modelLimits = {
                  'gpt-4': { count: 40, periodAmount: 3, periodUnit: 'hour', displayText: '40 per 3h' },
                  'gpt-4o': { count: 80, periodAmount: 3, periodUnit: 'hour', displayText: '80 per 3h' },
                  'o3': { count: 50, periodAmount: 1, periodUnit: 'week', displayText: '50 per week' },
                  'o3-mini': { count: 50, periodAmount: 1, periodUnit: 'week', displayText: '50 per week' },
                  'o4-mini': { count: 150, periodAmount: 1, periodUnit: 'day', displayText: '150 per day' },
                  'o4-mini-high': { count: 50, periodAmount: 1, periodUnit: 'day', displayText: '50 per day' },
                  'deep-research': { count: 10, periodAmount: 1, periodUnit: 'month', displayText: '10 per month' },
                  'dall-e-3': { count: 40, periodAmount: 3, periodUnit: 'hour', displayText: '40 per 3h' }
                };
              }
              
              // Find limit object for this model
              const modelLowerCase = modelToReset.toLowerCase();
              let limitObject = null;
              
              if (modelLimits[modelToReset]) {
                limitObject = modelLimits[modelToReset];
              } else if (modelLimits[modelLowerCase]) {
                limitObject = modelLimits[modelLowerCase];
              } else {
                // Try to find by partial match
                const matchingKey = Object.keys(modelLimits).find(key => 
                  modelLowerCase.includes(key.toLowerCase()) || key.toLowerCase().includes(modelLowerCase)
                );
                if (matchingKey) {
                  limitObject = modelLimits[matchingKey];
                }
              }
              
              // Calculate next reset time
              let nextResetTime = null;
              if (limitObject && limitObject.periodUnit !== 'unlimited' && limitObject.periodUnit !== 'none') {
                let resetDate = new Date(now);
                
                switch(limitObject.periodUnit) {
                  case 'hour':
                    resetDate.setHours(resetDate.getHours() + limitObject.periodAmount);
                    break;
                  case 'day':
                    resetDate.setDate(resetDate.getDate() + limitObject.periodAmount);
                    break;
                  case 'week':
                    resetDate.setDate(resetDate.getDate() + (limitObject.periodAmount * 7));
                    break;
                  case 'month':
                    resetDate.setMonth(resetDate.getMonth() + limitObject.periodAmount);
                    break;
                  default:
                    resetDate.setHours(resetDate.getHours() + 3);
                    break;
                }
                
                nextResetTime = resetDate.getTime();
                console.log(`ModelMeter Content: Calculated next reset time for manual reset of ${modelToReset}: ${new Date(nextResetTime).toLocaleString()}`);
              }
              
              // Send reset with both timestamps
              const resetResponse = await chrome.runtime.sendMessage({ 
                action: 'resetSingleModelCounter', 
                modelFullName: modelToReset,
                resetTimestamp: now,            // "Since" timestamp
                nextResetTime: nextResetTime,   // "Until" timestamp
                limitResetTime: nextResetTime   // Also set limitResetTime for compatibility
              });
              
              if (resetResponse && resetResponse.status === 'success') {
                updateInPagePanelData();
    updateUI();
              } else {
                updateStatusInPanel(`Failed to reset ${modelToReset}.`, 'error', 'inpage-status');
              }
            } catch (error) {
              console.error('ModelMeter Content: Error resetting counter:', error);
              updateStatusInPanel(`Error resetting counter. Please try again.`, 'error', 'inpage-status');
              if (error.message && error.message.includes('Extension context invalidated')) {
                handleExtensionContextError('resetSingleCounterInPanel');
              }
            }
          }
        });
      });
    } else { 
      countersEl.innerHTML = '<div class="no-data error">Failed to load.</div>'; 
    }
  } catch (error) {
    console.error('ModelMeter Content: Error loading model data or plan for panel:', error);
    countersEl.innerHTML = '<div class="no-data error">Error loading.</div>';
    if (error.message && error.message.includes('Extension context invalidated')) {
      handleExtensionContextError('updateInPagePanelData');
    }
  }
}

// Helper to update status messages within the in-page panel
function updateStatusInPanel(message, type, elementId) {
  if (!inPagePanel) return;
  const statusElement = inPagePanel.querySelector(`#${elementId}`);
  if (statusElement) {
    statusElement.textContent = message;
    statusElement.style.color = type === 'success' ? 'green' : (type === 'error' ? 'red' : 'orange');
  }
}

// Start watching for model changes and new messages
function startModelDetection() {
  try {
    detectCurrentModel(); // Initial detection

    const observer = new MutationObserver((mutationsList) => {
      for (const mutation of mutationsList) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const assistantMessages = [];
              if (node.matches('div[data-message-author-role="assistant"][data-message-id]')) {
                assistantMessages.push(node);
              } else {
                assistantMessages.push(...node.querySelectorAll('div[data-message-author-role="assistant"][data-message-id]'));
              }

              assistantMessages.forEach(messageDiv => {
                // Keep observer for updating currentModel, but NOT for incrementing
                const messageId = messageDiv.getAttribute('data-message-id');
                // Check if we *already* processed this ID via SSE to avoid unnecessary model updates
                if (!messageId || processedMessageIds.has(messageId)) return;

                const modelSlug = messageDiv.getAttribute('data-message-model-slug');
                if (modelSlug) {
                  // Update current model displayed if it changed
                  if (modelSlug !== currentModel) {
                      console.log(`ModelMeter Content (Observer): Updating currentModel from DOM attribute: ${modelSlug}`);
                      currentModel = modelSlug; // Use raw slug directly
                      updateUI(); // Update bubble display
                       if (inPagePanel && inPagePanel.style.display === 'block') {
                           updateInPagePanelData(); // Update panel if open
                       }
                  }
                  // Mark as seen by observer (though primary tracking is SSE)
                  messageDiv.dataset.modelMeterProcessedForBubble = 'true'; 
                }
              });
            }
          });
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    console.log('ModelMeter Content: Observer for new assistant messages started (for model detection only)');

    // Listener for model changes via menu clicks
    document.body.addEventListener('click', async (event) => {
      const menuItem = event.target.closest('div[role="menuitem"]');
      const popperContentWrapper = event.target.closest('div[data-radix-popper-content-wrapper]');

      if (menuItem && popperContentWrapper) {
        // Check if we are inside a menu that looks like a model switcher
        const menuTitleElement = popperContentWrapper.querySelector('div[role="menuitem"][aria-disabled="true"] span');
        const isLikelyModelMenu = (menuTitleElement && menuTitleElement.textContent.includes('Switch model')) ||
                                ['GPT-4o', 'o4-mini', 'GPT-4o mini', 'Auto', 'Try again'].some(text => popperContentWrapper.textContent.includes(text));

        if (!isLikelyModelMenu) {
          return; // Not a menu we are interested in
        }

        console.log('ModelMeter Content: Click detected inside a Radix menu item potentially related to model switching.', menuItem);

        let modelClicked = null;
        const textDivs = menuItem.querySelectorAll('span > div > div:first-child > div');
        
        let primaryText = '';
        let secondaryText = '';

        if (textDivs.length > 0 && textDivs[0].textContent) {
            primaryText = textDivs[0].textContent.trim();
        }
        if (textDivs.length > 1 && textDivs[1].textContent) {
            secondaryText = textDivs[1].textContent.trim();
        }
        
        console.log(`ModelMeter Content: Menu item texts - Primary: "${primaryText}", Secondary: "${secondaryText}"`);

        if (primaryText === 'Try again') {
            if (secondaryText) {
                modelClicked = secondaryText;
                console.log(`ModelMeter Content: "Try again" clicked, model: "${modelClicked}"`);
            }
        } else if (primaryText && primaryText !== 'Auto' && primaryText !== 'Switch model' && primaryText !== 'Without web search') {
            modelClicked = primaryText;
            console.log(`ModelMeter Content: Model menu item clicked: "${modelClicked}"`);
        } else {
            console.log(`ModelMeter Content: Clicked menu item "${primaryText}" - not counted as direct model selection.`);
        }

        if (modelClicked) {
            console.log(`ModelMeter Content: Updating current model to: ${modelClicked}`);
            currentModel = modelClicked; // Only update the current model, don't increment
            // Update UI to reflect the new current model
            updateUI();
            if (inPagePanel && inPagePanel.style.display === 'block') {
                updateInPagePanelData();
            }
        }
      }
    }, true);

  } catch (error) {
    console.error('ModelMeter Content: Model/Message detection observer setup failed', error);
    if (error.message && error.message.includes('Extension context invalidated')) {
      handleExtensionContextError('startModelDetection');
    }
  }
}

// Modify detectCurrentModel to handle initial state better
function detectCurrentModel() {
  try {
    // Priority 1: Model switcher button text (if exists and has content)
    const modelSwitcherButton = document.querySelector('button[data-testid="model-switcher-dropdown-button"]');
    if (modelSwitcherButton) {
      const modelNameSpan = modelSwitcherButton.querySelector('span.overflow-hidden.text-sm.text-clip.whitespace-nowrap');
      if (modelNameSpan && modelNameSpan.textContent && modelNameSpan.textContent.trim() !== '') {
        const rawButtonModel = modelNameSpan.textContent.trim();
        if (rawButtonModel !== currentModel) {
          console.log(`ModelMeter Content: Detected model from switcher button: ${rawButtonModel}`);
          currentModel = rawButtonModel; // Use raw text from button
          return true; // Indicate we found a model
        }
      }
    }
    
    // Priority 2: Last assistant message (if button method failed or button doesn't exist)
    const assistantMessageContents = document.querySelectorAll('div[data-message-author-role="assistant"][data-message-id]');
    if (assistantMessageContents.length > 0) {
      const lastAssistantMessageContentDiv = assistantMessageContents[assistantMessageContents.length - 1];
      const modelSlug = lastAssistantMessageContentDiv.getAttribute('data-message-model-slug');
      
      if (modelSlug && modelSlug !== currentModel) {
        console.log(`ModelMeter Content: Detected model from last assistant message slug: ${modelSlug}`);
        currentModel = modelSlug; // Use raw slug
        return true; // Indicate we found a model
      }
    }
    
    // If no model found yet
    if (currentModel === null) {
      console.log('ModelMeter Content: No model detected yet (waiting for first interaction)');
      return false;
    }
    
    return true; // Current model is still valid
  } catch (error) {
    console.error('ModelMeter Content: Error in detectCurrentModel', error);
    if (error.message && error.message.includes('Extension context invalidated')) {
      handleExtensionContextError('detectCurrentModel');
    }
    return false;
  }
}

// Modify setupMessageListeners to handle context errors
function setupMessageListeners() {
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('ModelMeter Debug: 📩 Content received message:', message);
      
      if (message.action === 'ping') {
        sendResponse({ 
          status: 'success', 
          model: currentModel, 
          url: window.location.href 
        });
        return true; 
      }
      
      if (message.action === 'refreshBubble') {
        console.log('ModelMeter Debug: 🔄 Refreshing bubble on tab activation');
        detectCurrentModel();
        updateUI();
        if (inPagePanel && inPagePanel.style.display === 'block') {
          updateInPagePanelData();
        }
        sendResponse({status: 'success'});
        return true;
      }

      if (message.action === 'countersDisplayShouldRefresh') {
        console.log('ModelMeter Debug: 🔄 Received countersDisplayShouldRefresh');
        updateUI();
        if (inPagePanel && inPagePanel.style.display === 'block') {
          updateInPagePanelData();
        }
        sendResponse({status: 'success'});
        return true;
      }
      
      // Handler for API-based model usage detection
      if (message.action === 'modelUsedFromApi') {
        console.log(`ModelMeter Debug: ✅ Received modelUsedFromApi for model: ${message.modelName}`);
        // Update currentModel if provided in the message
        if (message.modelName) {
          currentModel = message.modelName;
          console.log(`ModelMeter Debug: ✅ Updated currentModel to ${currentModel} from API detection`);
        }
        
        // Update UI components
        updateUI();
        if (inPagePanel && inPagePanel.style.display === 'block') {
          updateInPagePanelData();
        }
        
        sendResponse({status: 'success'});
        return true;
      }
      
      sendResponse({status: 'error', message: 'Unknown action'});
      return true;
    });
    
    console.log('ModelMeter Debug: 👂 Message listeners set up successfully');
  } catch (error) {
    console.error('ModelMeter Debug: ❌ Error setting up message listeners', error);
    if (error.message && error.message.includes('Extension context invalidated')) {
      handleExtensionContextError('setupMessageListeners');
    }
  }
}

// Setup detection for visibility changes (tab/window focus)
function setupVisibilityChangeDetection() {
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      console.log('ModelMeter: Document became visible, refreshing data and checking connection');
      
      // First, perform a health check to ensure extension is still working
      performHealthCheck().catch(error => {
        console.error('ModelMeter: Health check failed on tab focus:', error);
        // If health check fails, the performHealthCheck function will handle showing the reload message
      });
      
      // Update current model and UI
      detectCurrentModel();
      updateUI();
      
      // Check for rate limit banners and expired models when tab becomes visible
      checkAndParseRateLimitBanner();
      checkAndResetExpiredModels();
      
      // Also verify connection to background script with a simple ping
      safeSendMessage({ action: 'ping' }, { suppressErrors: true }).then(response => {
        if (!response) {
          console.warn('ModelMeter: Failed to ping background script on tab focus');
          showReloadPageMessage('ModelMeter lost connection to background script. Please refresh the page to restore functionality.');
        } else {
          console.log('ModelMeter: Successfully pinged background script on tab focus');
        }
      }).catch(error => {
        console.error('ModelMeter: Error pinging background script on tab focus:', error);
        showReloadPageMessage('ModelMeter connection error on tab focus. Please refresh the page to restore functionality.');
      });
    }
  });
  
  console.log('ModelMeter: Visibility change detection set up with health checks');
}

// Update the UI bubble with raw model name AND ITS COUNT
async function updateUI() { // Bubble UI
  try {
    if (!uiInitialized || !bubbleElement) {
      console.log('ModelMeter Content: UI not initialized yet, skipping update');
      return;
    }
    
    // Check if document is still valid
    if (!document || !document.body || !document.body.contains(bubbleElement)) {
      console.log('ModelMeter Content: Document structure changed, bubble element no longer in DOM');
      return;
    }
    
    // Always detect current model first (this doesn't require background communication)
    detectCurrentModel();
    
    // Display raw currentModel or '??' if null
    const displayName = currentModel || '??';
    let count = '?';

    if (currentModel) { // currentModel is the raw name/slug
      console.log(`ModelMeter Content: Getting count for raw model: ${currentModel}`);
      
      try {
        const response = await safeSendMessage({ 
          action: 'getModelCount', 
          modelFullName: currentModel 
        }, { suppressErrors: true });
        
        if (response && response.status === 'success') {
          count = response.count;
          console.log(`ModelMeter Content: Successfully got count ${count} for ${currentModel}`);
        } else {
          console.warn('ModelMeter Content: Failed to get model count from background for', currentModel, 'Response:', response);
          count = '?'; // Show ? when background fails
        }
      } catch (error) {
        console.error('ModelMeter Content: Error getting model count:', error);
        count = '?'; // Show ? when there's an error
      }
    }
    
    // Final safety check before DOM update
    if (bubbleElement && document.body.contains(bubbleElement)) {
      const bubbleText = `${displayName} · ${count}`;
      bubbleElement.textContent = bubbleText;
      console.log(`ModelMeter Content: Updated bubble to "${bubbleText}"`);
      
      // Change bubble color based on communication status
      if (count === '?') {
        // Red background when communication fails
        bubbleElement.style.backgroundColor = '#dc2626';
        bubbleElement.style.borderColor = '#fca5a5';
      } else {
        // Normal blue background when working
        bubbleElement.style.backgroundColor = '#0078D7';
        bubbleElement.style.borderColor = 'white';
      }
    } else {
      console.log('ModelMeter Content: Bubble element no longer in DOM, cannot update');
    }
  } catch (error) {
    console.error('ModelMeter Content: Error in updateUI function:', error);
    
    // Even if there's an error, try to show current model without count
    if (bubbleElement && document.body.contains(bubbleElement)) {
      const displayName = currentModel || '??';
      bubbleElement.textContent = `${displayName} · ?`;
      bubbleElement.style.backgroundColor = '#dc2626'; // Red for error state
    }
  }
}

// At around line 45, add this function to handle extension context errors
function handleExtensionContextError(source) {
  console.error(`ModelMeter Content: Extension context invalidated during ${source}. Refresh needed.`);
  
  try {
    // Safety check - don't try to manipulate DOM if document.body doesn't exist
    if (!document || !document.body) {
      console.log('ModelMeter Content: document.body not available, cannot display error message');
      return;
    }
    
    // Remove any existing error messages to avoid duplicates
    const existingMessages = document.querySelectorAll('.modelmeter-error-message');
    existingMessages.forEach(msg => {
      try {
        msg.remove();
      } catch (e) {
        // Silently ignore removal errors
      }
    });
    
    // Create a new error message
    const errorDiv = document.createElement('div');
    errorDiv.className = 'modelmeter-error-message';
    errorDiv.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      background-color: #fee2e2;
      color: #b91c1c;
      border: 1px solid #f87171;
      border-radius: 4px;
      padding: 10px;
      z-index: 10000;
      font-family: sans-serif;
      font-size: 14px;
      max-width: 300px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    `;
    
    // Create close button
    const closeButton = document.createElement('button');
    closeButton.textContent = '×';
    closeButton.style.cssText = `
      position: absolute;
      top: 5px;
      right: 5px;
      border: none;
      background: none;
      color: #b91c1c;
      font-size: 18px;
      cursor: pointer;
      padding: 0;
      margin: 0;
      width: 20px;
      height: 20px;
      line-height: 20px;
      text-align: center;
    `;
    closeButton.onclick = function() {
      try {
        errorDiv.remove();
      } catch (e) {
        // Silently ignore removal errors
      }
    };
    
    // Message content
    const messageP = document.createElement('p');
    messageP.textContent = 'ModelMeter extension context invalidated. Please refresh the page to restore functionality.';
    messageP.style.margin = '0 0 10px 0';
    
    // Refresh button
    const refreshButton = document.createElement('button');
    refreshButton.textContent = 'Refresh Page';
    refreshButton.style.cssText = `
      background-color: #dc2626;
      color: white;
      border: none;
      border-radius: 4px;
      padding: 5px 10px;
      cursor: pointer;
      font-size: 14px;
    `;
    refreshButton.onclick = function() {
      window.location.reload();
    };
    
    // Build and append the error message
    errorDiv.appendChild(closeButton);
    errorDiv.appendChild(messageP);
    errorDiv.appendChild(refreshButton);
    
    // Try to append to document body with error handling
    try {
      document.body.appendChild(errorDiv);
    } catch (error) {
      console.error('ModelMeter Content: Failed to append error message to document.body', error);
    }
  } catch (error) {
    console.error('ModelMeter Content: Error creating error message UI', error);
  }
}

// Add missing click handler to close panel when clicking outside
function setupOutsideClickHandler() {
    document.addEventListener('click', function(event) {
        // If panel exists and is visible
        if (inPagePanel && inPagePanel.style.display === 'block') {
            // Check if the click was outside both the panel and the toggle button
            if (!inPagePanel.contains(event.target) && 
                (!panelToggleButton || !panelToggleButton.contains(event.target))) {
                console.log('ModelMeter Content: Click outside panel detected, hiding panel');
                inPagePanel.style.display = 'none';
            }
        }
        
        // Close config modal when clicking outside
        const configModal = document.getElementById('modelmeter-config-modal');
        if (configModal && configModal.style.display === 'flex') {
            // Check if the click was outside the modal content
            const modalContent = configModal.querySelector('.config-modal-content');
            if (modalContent && !modalContent.contains(event.target)) {
                console.log('ModelMeter Content: Click outside config modal detected, hiding modal');
                configModal.style.display = 'none';
            }
        }
    });
    console.log('ModelMeter Content: Outside click handler set up for panel and config modal');
}

// --- NEW: Styles for Plan Labels ---
const planLabelStyleSheet = document.createElement("style");
planLabelStyleSheet.type = "text/css";
planLabelStyleSheet.innerText = `
  .plan-label {
    transition: all 0.2s ease;
    border: 1px solid #dee2e6;
    background-color: #fff;
    font-size: 13px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    user-select: none;
    border-radius: 20px;
  }
  
  .plan-label:hover {
    border-color: #c1c9d0;
    background-color: #f8f9fa;
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  }
  
  .plan-label:active {
    transform: translateY(0);
    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
  }
  
  .plan-label-selected {
    color: #fff !important;
    border: 1px solid transparent;
  }
  
  #user-plan-label-free.plan-label-selected {
    background-color: #007bff;
  }
  
  #user-plan-label-plus.plan-label-selected {
    background-color: #28a745;
  }
  
  #user-plan-label-free.plan-label-selected:hover {
    background-color: #0069d9;
  }
  
  #user-plan-label-plus.plan-label-selected:hover {
    background-color: #218838;
  }
`;
document.head.appendChild(planLabelStyleSheet);
// --- END NEW ---

// --- NEW: Function to proactively check for and parse the Rate Limit Banner ---
function checkAndParseRateLimitBanner() {
  console.log('ModelMeter Debug (Banner Check): 🔍 Checking for rate limit banners...');
  
  // Prioritized selectors, from most specific to more general
  const selectorGroups = [
    // Group 1: Very specific selectors for rate limit banners
    [
      '.rounded-3xl.border.py-4', // Most common rate limit banner class
      'div[role="dialog"] .border.py-4', // Rate limit in modal dialog
      'div[role="alert"]' // Explicit alert role
    ],
    // Group 2: Fallback selectors, only used if nothing found with specific ones
    [
      'div[class*="main"] > div > div > div > div[class*="border"]',
      'div.relative.h-full.w-full > div.mb-2.flex.flex-col > div > div.flex.w-full.rounded-3xl.border.py-4'
    ]
  ];
  
  let bannerFound = false;

  // Try each selector group in order of priority
  for (const selectorGroup of selectorGroups) {
    if (bannerFound) break; // Stop if we already found a banner
    
    // Try each selector in the current group
    for (const selector of selectorGroup) {
      const potentialBanners = document.querySelectorAll(selector);
      
      for (const bannerNode of potentialBanners) {
        // Size sanity check - skip elements that are too large (likely not banners)
        if (bannerNode.textContent.length > 1000) {
          continue;
        }
        
        // Get banner text
        const bannerText = bannerNode.textContent.trim();
        
        // Skip if empty or too short
        if (!bannerText || bannerText.length < 10) {
          continue;
        }
        
        // Extract title-like element text for better model name extraction
        const titleElement = bannerNode.querySelector('.font-bold, div[class*="font-bold"], div[class*="text-token-text-primary"]');
        const titleText = titleElement ? titleElement.textContent.trim() : '';
        
        // Check if this looks like a rate limit message or warning
        const bannerTextLower = bannerText.toLowerCase();
        const isRateLimit = 
          (bannerTextLower.includes("hit the") && bannerTextLower.includes("limit")) ||
          (bannerTextLower.includes("reached") && bannerTextLower.includes("limit")) ||
          bannerTextLower.includes("rate limit") ||
          bannerTextLower.includes("usage cap") ||
          bannerTextLower.includes("usage limit");
        
        // Check if this is a warning banner (not a limit reached banner)
        const isWarningBanner = 
          (bannerTextLower.includes("remaining") || bannerTextLower.includes("left")) &&
          (bannerTextLower.includes("responses") || bannerTextLower.includes("resets"));
        
        if (!isRateLimit && !isWarningBanner) {
          continue; // Not a rate limit or warning banner, skip to next element
        }
        
        // We found what looks like a rate limit banner or warning
        bannerFound = true;
        console.log('ModelMeter Debug (Banner Check): 🎯 Rate Limit or Warning Banner Found:', titleText || bannerText.substring(0, 50));
        
        // Parse the banner to extract model and reset time
        const parsedInfo = parseRateLimitBanner(bannerNode, titleText, bannerText);
        
        if (parsedInfo && parsedInfo.modelSlug) {
          console.log('ModelMeter Debug (Banner Check): ✅ Successfully parsed banner:', parsedInfo);
          
          // Normalize the model slug to match our naming convention
          const normalizedModelSlug = normalizeModelName(parsedInfo.modelSlug);
          const bannerStatedResetTime = parsedInfo.resetTimestamp; // This is the time stated in the banner
          const isWarning = parsedInfo.isWarningBanner || false;
          const warningText = parsedInfo.warningText || null;

          // Prepare the message to send to the background script
          const message = {
            action: 'rateLimitHit',
            modelSlug: normalizedModelSlug,
            newSinceTimestampFromBanner: bannerStatedResetTime, // User wants this as the new 'Start'
            storeResetTime: true, // Signal to background to calculate 'Until' and store both
            resetCounter: !isWarning // Only reset the counter for actual limit hit banners, not warnings
          };
          
          // For o3 warning banners, include the full warning text for further parsing
          if (isWarning && warningText && normalizedModelSlug.toLowerCase().includes('o3')) {
            message.warningText = warningText;
            console.log(`ModelMeter Debug (Banner Check): 📨 Sending o3 warning banner text to background script`);
          }
          
          console.log(`ModelMeter Debug (Banner Check): 📤 Sending rate limit info to background. Model: ${normalizedModelSlug}, Banner Stated Reset Time: ${bannerStatedResetTime ? new Date(bannerStatedResetTime).toLocaleString() : 'None'}, Is Warning: ${isWarning}`);
          
          // Send message to background script
          chrome.runtime.sendMessage(message).then(response => {
            console.log(`ModelMeter Debug (Banner Check): ✅ Rate limit info sent, response:`, response);
            
            // Update UI to reflect changes
            updateUI();
            if (inPagePanel && inPagePanel.style.display === 'block') {
              updateInPagePanelData();
            }
          }).catch(err => {
            console.error('ModelMeter Debug (Banner Check): ❌ Error sending rate limit info:', err);
            if (err.message && err.message.includes('Extension context invalidated')) {
              handleExtensionContextError('sendRateLimitInfo');
            }
          });
          
          // Found and processed a valid banner, exit the loop
          break;
        } else {
          console.warn('ModelMeter Debug (Banner Check): ⚠️ Failed to parse banner completely');
          bannerFound = false; // Reset so we can try other selectors
        }
      }
      
      if (bannerFound) break; // If we found a valid banner, exit the selector loop
    }
  }

  if (!bannerFound) {
    console.log('ModelMeter Debug (Banner Check): No rate limit banners found');
  }
}

// Function to parse rate limit banner text and extract model name and reset time
function parseRateLimitBanner(bannerNode, titleText, bannerText) {
  try {
    let modelSlug = '';
    let resetTimestamp = null;
    let isWarningBanner = false;
    
    // First try to extract model name from the title or banner text
    if (titleText) {
      // Check for model names in title text
      const titleLower = titleText.toLowerCase();
      
      // Check if this is a warning banner (not a limit reached banner)
      if (titleLower.includes('remaining') || titleLower.includes('left')) {
        isWarningBanner = true;
      }
      
      if (titleLower.includes('gpt-4') || titleLower.includes('gpt4')) {
        if (titleLower.includes('o') || titleLower.includes('0')) {
          if (titleLower.includes('mini')) {
            modelSlug = 'gpt-4o-mini';
          } else {
            modelSlug = 'gpt-4o';
          }
        } else {
          modelSlug = 'gpt-4';
        }
      } else if (titleLower.includes('o3')) {
        modelSlug = 'o3';
      } else if (titleLower.includes('o4')) {
        if (titleLower.includes('mini')) {
          if (titleLower.includes('high')) {
            modelSlug = 'o4-mini-high';
          } else {
            modelSlug = 'o4-mini';
          }
        }
      }
    }
    
    // If no model found in title, try the full banner text
    if (!modelSlug) {
      const bannerLower = bannerText.toLowerCase();
      
      // Check if this is a warning banner (not a limit reached banner)
      if (bannerLower.includes('remaining') || bannerLower.includes('left')) {
        isWarningBanner = true;
      }
      
      if (bannerLower.includes('gpt-4o-mini') || bannerLower.includes('gpt4o mini')) {
        modelSlug = 'gpt-4o-mini';
      } else if (bannerLower.includes('gpt-4o') || bannerLower.includes('gpt4o')) {
        modelSlug = 'gpt-4o';
      } else if (bannerLower.includes('gpt-4') || bannerLower.includes('gpt4')) {
        modelSlug = 'gpt-4';
      } else if (bannerLower.includes('o3-mini')) {
        modelSlug = 'o3-mini';
      } else if (bannerLower.includes('o3')) {
        modelSlug = 'o3';
      } else if (bannerLower.includes('o4-mini-high')) {
        modelSlug = 'o4-mini-high';
      } else if (bannerLower.includes('o4-mini')) {
        modelSlug = 'o4-mini';
      }
    }
    
    // Now extract the reset time from the banner text
    const fullTextForTimeParsing = bannerText; // Keep original case for AM/PM if needed, though regex is case-insensitive
    
    // First check for future reset date in warning banners (specifically for o3)
    // Example: "If you hit the limit, responses will switch to another model until it resets May 19, 2025."
    if (isWarningBanner && modelSlug && modelSlug.toLowerCase().includes('o3')) {
      const futureResetDateMatch = fullTextForTimeParsing.match(/until it resets\s+([A-Za-z]+\s+\d+,\s+\d{4})/i);
      
      if (futureResetDateMatch && futureResetDateMatch[1]) {
        try {
          const futureDate = new Date(futureResetDateMatch[1]);
          if (!isNaN(futureDate.getTime())) {
            // For o3 warning banners, we'll let the background script handle the calculation
            // of "since" and "until" timestamps based on the parsed date
            resetTimestamp = futureDate.getTime();
            console.log(`ModelMeter Debug (Banner Parse): Parsed future o3 reset date: ${new Date(resetTimestamp).toLocaleString()}`);
            
            return {
              modelSlug,
              resetTimestamp,
              isWarningBanner: true,
              warningText: fullTextForTimeParsing // Include the full warning text for further parsing in background
            };
          }
        } catch (error) {
          console.error('ModelMeter Debug (Banner Parse): ❌ Error parsing future reset date:', error);
        }
      }
    }
    
    // Attempt to parse absolute time first (e.g., "4:28 PM")
    const absoluteTimeMatch = fullTextForTimeParsing.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (absoluteTimeMatch) {
      let hours = parseInt(absoluteTimeMatch[1], 10);
      const minutes = parseInt(absoluteTimeMatch[2], 10);
      const ampm = absoluteTimeMatch[3].toUpperCase();

      if (ampm === 'PM' && hours < 12) {
        hours += 12;
      } else if (ampm === 'AM' && hours === 12) { // Midnight case (12 AM is 00 hours)
        hours = 0;
      }

      if (!isNaN(hours) && !isNaN(minutes)) {
        const now = new Date();
        const potentialResetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);

        // If the parsed time for today is in the past, assume it's for the next day
        if (potentialResetDate.getTime() < now.getTime()) {
          potentialResetDate.setDate(potentialResetDate.getDate() + 1);
        }
        resetTimestamp = potentialResetDate.getTime();
        console.log(`ModelMeter Debug (Banner Parse): Parsed absolute time from banner: ${new Date(resetTimestamp).toLocaleString()}`);
      }
    }

    // If absolute time wasn't found or parsed, try relative time patterns
    if (!resetTimestamp) {
      const textLower = fullTextForTimeParsing.toLowerCase();
      const hourPatterns = [
        /in (\d+) hours?/i,
        /after (\d+) hours?/i,
        /(\d+) hours? from now/i,
        /reset in (\\d+) hours?/i
      ];
      const minutePatterns = [
        /in (\d+) minutes?/i,
        /after (\d+) minutes?/i,
        /(\d+) minutes? from now/i,
        /reset in (\\d+) minutes?/i
      ];

      for (const pattern of hourPatterns) {
        const match = textLower.match(pattern);
        if (match && match[1]) {
          const hours = parseInt(match[1], 10);
          if (!isNaN(hours)) {
            const now = new Date();
            now.setHours(now.getHours() + hours);
            resetTimestamp = now.getTime();
            console.log(`ModelMeter Debug (Banner Parse): Parsed relative time from banner (+${hours}h): ${new Date(resetTimestamp).toLocaleString()}`);
            break;
          }
        }
      }

      if (!resetTimestamp) {
        for (const pattern of minutePatterns) {
          const match = textLower.match(pattern);
          if (match && match[1]) {
            const minutes = parseInt(match[1], 10);
            if (!isNaN(minutes)) {
              const now = new Date();
              now.setMinutes(now.getMinutes() + minutes);
              resetTimestamp = now.getTime();
              console.log(`ModelMeter Debug (Banner Parse): Parsed relative time from banner (+${minutes}m): ${new Date(resetTimestamp).toLocaleString()}`);
              break;
            }
          }
        }
      }
      
      // Special case for "3 hours" default time if other relative patterns didn't match
      if (!resetTimestamp && (textLower.includes('3 hours') || textLower.includes('three hours'))) {
        const now = new Date();
        now.setHours(now.getHours() + 3);
        resetTimestamp = now.getTime();
        console.log(`ModelMeter Debug (Banner Parse): Parsed '3 hours' specific case: ${new Date(resetTimestamp).toLocaleString()}`);
      }
    }
    
    // If we have a model slug and still no resetTimestamp, apply default
    if (modelSlug && !resetTimestamp) {
      const now = new Date();
      now.setHours(now.getHours() + 3); // Default to 3 hours from now
      resetTimestamp = now.getTime();
      console.log(`ModelMeter Debug (Banner Parse): Applied default reset time (+3h): ${new Date(resetTimestamp).toLocaleString()}`);
    }
    
    if (modelSlug && resetTimestamp) {
      return {
        modelSlug,
        resetTimestamp // This is the "Until" timestamp
      };
    }
    
    console.warn('ModelMeter Debug (Banner Parse): Could not parse model slug or reset time from banner.', { titleText, bannerText });
    return null;
  } catch (error) {
    console.error('ModelMeter Debug (Banner Parse): ❌ Error parsing rate limit banner:', error);
    return null;
  }
}

// Helper function to normalize model names from banner to match our naming convention
function normalizeModelName(rawModelName) {
  // Strip any punctuation and standardize
  const cleaned = rawModelName.trim().toLowerCase()
    .replace(/[^\w\s-]/g, '')  // Remove special chars except hyphens
    .replace(/\s+/g, '-');     // Replace spaces with hyphens
    
  // Map of common model name variations to our standard names
  const modelNameMap = {
    'gpt-4': 'gpt-4',
    'gpt4': 'gpt-4',
    'gpt-4o': 'gpt-4o',
    'gpt4o': 'gpt-4o',
    'gpt-4-o': 'gpt-4o',
    '4o': 'gpt-4o',
    'gpt-4-turbo': 'gpt-4',
    'gpt-4-1106': 'gpt-4',
    'gpt-4o-mini': 'gpt-4o-mini',
    'gpt4o-mini': 'gpt-4o-mini',
    '4o-mini': 'gpt-4o-mini',
    'o3': 'o3',
    'o3-mini': 'o3-mini',
    'o4-mini': 'o4-mini',
    'o4-mini-high': 'o4-mini-high',
    'o4minihi': 'o4-mini-high',
    'gpt-4o-mini-high': 'o4-mini-high'
  };
  
  // Try direct match first
  if (modelNameMap[cleaned]) {
    return modelNameMap[cleaned];
  }
  
  // Try to find partial matches
  for (const [key, value] of Object.entries(modelNameMap)) {
    if (cleaned.includes(key)) {
      return value;
    }
  }
  
  // If no match, just return our best guess at standard formatting
  if (cleaned.includes('4o') && cleaned.includes('mini')) {
    return 'gpt-4o-mini';
  } else if (cleaned.includes('4o')) {
    return 'gpt-4o';
  } else if (cleaned.includes('o4')) {
    return 'o4-mini';
  } else if (cleaned.includes('o3')) {
    return 'o3';
  }
  
  // Last resort, just return the cleaned version
  return cleaned;
}
// --- END: Proactive Banner Check Function ---

// --- Function to check and reset expired model counters ---
async function checkAndResetExpiredModels() {
  const now = new Date();
  const nowTimestamp = now.getTime();
  console.log(`ModelMeter Debug (Expiration Check): 🕐 Starting expiration check at ${now.toISOString()} (${nowTimestamp})`);
  
  // Check extension context validity with retries
  let pingResponse = null;
  let retries = 3;
  
  while (retries > 0 && !pingResponse) {
    pingResponse = await safeSendMessage({ action: 'ping' }, { suppressErrors: true });
    if (!pingResponse) {
      retries--;
      console.log(`ModelMeter Debug (Expiration Check): ⚠️ Ping failed, ${retries} retries left`);
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
      }
    }
  }
  
  if (!pingResponse) {
    console.log('ModelMeter Debug (Expiration Check): ❌ Extension context invalid after retries, skipping expired model check');
    showReloadPageMessage('ModelMeter background script not responding. Expiration checks suspended. Please refresh the page.');
    return;
  }
  
  console.log('ModelMeter Debug (Expiration Check): ✅ Background script responding, proceeding with expiration check');
  
  try {
    // Get current model data from storage with retries
    let response = null;
    retries = 3;
    
    while (retries > 0 && !response) {
      response = await safeSendMessage({ action: 'getModelData' }, { suppressErrors: true });
      if (!response || response.status !== 'success' || !response.data) {
        retries--;
        console.log(`ModelMeter Debug (Expiration Check): ⚠️ Model data fetch failed, ${retries} retries left`);
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
        }
      }
    }
    
    if (!response || response.status !== 'success' || !response.data) {
      console.log('ModelMeter Debug (Expiration Check): ❌ Failed to get model data after retries');
      showReloadPageMessage('ModelMeter cannot access model data. Please refresh the page to restore functionality.');
      return;
    }

    const modelData = response.data;
    let resetsPerformed = 0;
    let modelsToReset = [];

    console.log(`ModelMeter Debug (Expiration Check): 📊 Checking ${Object.keys(modelData).length} models for expiration`);

    // First identify all models that need reset with detailed logging
    for (const [modelName, modelInfo] of Object.entries(modelData)) {
      // Check both possible property names and validate they are valid timestamps
      const nextResetTime = modelInfo.nextResetTime || modelInfo.limitResetTime;
      
      if (nextResetTime) {
        // Validate that nextResetTime is a valid number
        const resetTimestamp = typeof nextResetTime === 'number' ? nextResetTime : parseInt(nextResetTime, 10);
        
        if (isNaN(resetTimestamp) || resetTimestamp <= 0) {
          console.log(`ModelMeter Debug (Expiration Check): ⚠️ Model "${modelName}" has invalid reset timestamp: ${nextResetTime} - skipping`);
          continue;
        }
        
        const resetDate = new Date(resetTimestamp);
        
        // Validate the resulting date is valid
        if (isNaN(resetDate.getTime())) {
          console.log(`ModelMeter Debug (Expiration Check): ⚠️ Model "${modelName}" reset timestamp creates invalid date: ${resetTimestamp} - skipping`);
          continue;
        }
        
        const timeDiffMs = nowTimestamp - resetTimestamp;
        const timeDiffMinutes = Math.round(timeDiffMs / (1000 * 60));
        const timeUntilResetMs = resetTimestamp - nowTimestamp;
        const timeUntilResetMinutes = Math.round(timeUntilResetMs / (1000 * 60));
        
        console.log(`ModelMeter Debug (Expiration Check): 🔍 Model "${modelName}":
          - Current time: ${now.toISOString()} (${nowTimestamp})
          - Reset time: ${resetDate.toISOString()} (${resetTimestamp})
          - Time since reset: ${timeDiffMs}ms (${timeDiffMinutes} minutes)
          - Time until reset: ${timeUntilResetMs}ms (${timeUntilResetMinutes} minutes)
          - Is expired: ${nowTimestamp > resetTimestamp ? 'YES' : 'NO'}`);
        
        // Use strict greater than comparison - if current time is past reset time, it's expired
        if (nowTimestamp > resetTimestamp) {
          console.log(`ModelMeter Debug (Expiration Check): ⏰ Model "${modelName}" has expired by ${timeDiffMinutes} minutes! Adding to reset queue.`);
          modelsToReset.push(modelName);
        } else {
          console.log(`ModelMeter Debug (Expiration Check): ✅ Model "${modelName}" is still valid for ${Math.abs(timeUntilResetMinutes)} more minutes.`);
        }
      } else {
        console.log(`ModelMeter Debug (Expiration Check): ⚠️ Model "${modelName}" has no reset time set - skipping`);
      }
    }
    
    if (modelsToReset.length === 0) {
      console.log('ModelMeter Debug (Expiration Check): ✅ No models need to be reset at this time');
      return;
    }

    console.log(`ModelMeter Debug (Expiration Check): 🎯 Found ${modelsToReset.length} models to reset: [${modelsToReset.join(', ')}]`);

    // Get user plan information once for all resets
    let currentPlan = 'FREE';
    const planResponse = await safeSendMessage({ action: 'getUserPlan' }, { suppressErrors: true });
    if (planResponse && planResponse.status === 'success') {
      currentPlan = planResponse.plan;
      console.log(`ModelMeter Debug (Expiration Check): 📋 User plan: ${currentPlan}`);
    } else {
      console.log(`ModelMeter Debug (Expiration Check): ⚠️ Failed to get user plan, defaulting to FREE`);
    }
    
    // Define model limits based on plan
    let modelLimits = {};
    if (currentPlan === 'FREE') {
      modelLimits = {
        'gpt-4o': { count: 15, periodAmount: 3, periodUnit: 'hour', displayText: '~15 per 3h' },
        'gpt-4o-mini': { count: Infinity, periodAmount: 0, periodUnit: 'unlimited', displayText: 'Unlimited' },
        'o3-mini': { count: 0, periodAmount: 0, periodUnit: 'none', displayText: '0' },
        'o4-mini': { count: 20, periodAmount: 5, periodUnit: 'hour', displayText: '~20 per 5h' },
        'o4-mini-high': { count: 0, periodAmount: 0, periodUnit: 'none', displayText: '0' },
        'deep-research-lite': { count: 5, periodAmount: 1, periodUnit: 'month', displayText: '5 per month' },
        'dall-e-3': { count: 3, periodAmount: 1, periodUnit: 'day', displayText: '3 per day' }
      };
    } else if (currentPlan === 'PLUS') {
      modelLimits = {
        'gpt-4': { count: 40, periodAmount: 3, periodUnit: 'hour', displayText: '40 per 3h' },
        'gpt-4o': { count: 80, periodAmount: 3, periodUnit: 'hour', displayText: '80 per 3h' },
        'o3': { count: 50, periodAmount: 1, periodUnit: 'week', displayText: '50 per week' },
        'o3-mini': { count: 50, periodAmount: 1, periodUnit: 'week', displayText: '50 per week' },
        'o4-mini': { count: 150, periodAmount: 1, periodUnit: 'day', displayText: '150 per day' },
        'o4-mini-high': { count: 50, periodAmount: 1, periodUnit: 'day', displayText: '50 per day' },
        'deep-research': { count: 10, periodAmount: 1, periodUnit: 'month', displayText: '10 per month' },
        'dall-e-3': { count: 40, periodAmount: 3, periodUnit: 'hour', displayText: '40 per 3h' }
      };
    }

    // Now process each model that needs reset - one at a time with error handling
    for (const modelName of modelsToReset) {
      console.log(`ModelMeter Debug (Expiration Check): 🔧 Processing reset for "${modelName}"`);
      
      // Find the limit object for this model
      const modelLowerCase = modelName.toLowerCase();
      let limitObject = null;
      
      // Try to find by model name
      if (modelLimits[modelName]) {
        limitObject = modelLimits[modelName];
        console.log(`ModelMeter Debug (Expiration Check): ✅ Found limit by exact match for "${modelName}"`);
      } else if (modelLimits[modelLowerCase]) {
        limitObject = modelLimits[modelLowerCase];
        console.log(`ModelMeter Debug (Expiration Check): ✅ Found limit by lowercase match for "${modelName}"`);
      } else {
        // Try to find by partial match
        const matchingKey = Object.keys(modelLimits).find(key => 
          modelLowerCase.includes(key.toLowerCase()) || key.toLowerCase().includes(modelLowerCase)
        );
        if (matchingKey) {
          limitObject = modelLimits[matchingKey];
          console.log(`ModelMeter Debug (Expiration Check): ✅ Found limit by partial match for "${modelName}" -> "${matchingKey}"`);
        } else {
          console.log(`ModelMeter Debug (Expiration Check): ⚠️ No limit object found for "${modelName}"`);
        }
      }
      
      // Use current time as the new "Since" timestamp
      const newSinceTimestamp = nowTimestamp;
      
      // Calculate the next reset time based on current time plus the period
      let newUntilTimestamp = null;
      if (limitObject && limitObject.periodUnit !== 'unlimited' && limitObject.periodUnit !== 'none') {
        const newResetDate = new Date(nowTimestamp);
        
        // Calculate next reset time based on period
        switch(limitObject.periodUnit) {
          case 'hour':
            newResetDate.setHours(newResetDate.getHours() + limitObject.periodAmount);
            break;
          case 'day':
            newResetDate.setDate(newResetDate.getDate() + limitObject.periodAmount);
            break;
          case 'week':
            newResetDate.setDate(newResetDate.getDate() + (limitObject.periodAmount * 7));
            break;
          case 'month':
            newResetDate.setMonth(newResetDate.getMonth() + limitObject.periodAmount);
            break;
          default:
            // Default to 3 hours if we can't determine
            newResetDate.setHours(newResetDate.getHours() + 3);
            console.log(`ModelMeter Debug (Expiration Check): ⚠️ Unknown period unit "${limitObject.periodUnit}" for "${modelName}", defaulting to 3 hours`);
            break;
        }
        
        newUntilTimestamp = newResetDate.getTime();
        
        // Validate the calculated timestamp
        if (isNaN(newUntilTimestamp) || newUntilTimestamp <= nowTimestamp) {
          console.error(`ModelMeter Debug (Expiration Check): ❌ Invalid calculated reset time for "${modelName}": ${newUntilTimestamp}`);
          // Fallback to 3 hours from now
          const fallbackDate = new Date(nowTimestamp);
          fallbackDate.setHours(fallbackDate.getHours() + 3);
          newUntilTimestamp = fallbackDate.getTime();
          console.log(`ModelMeter Debug (Expiration Check): 🔧 Using fallback reset time for "${modelName}": ${new Date(newUntilTimestamp).toISOString()}`);
        } else {
          console.log(`ModelMeter Debug (Expiration Check): 📅 Calculated new reset time for "${modelName}": ${new Date(newUntilTimestamp).toISOString()} (${limitObject.periodAmount} ${limitObject.periodUnit}(s) from now)`);
        }
      } else {
        console.log(`ModelMeter Debug (Expiration Check): ⚠️ Model "${modelName}" has no period or is unlimited/none - no next reset time calculated`);
      }
      
      console.log(`ModelMeter Debug (Expiration Check): 📤 Sending reset request for "${modelName}" to background script...`);
      
      // Reset the counter and update both timestamps with retries
      let resetResponse = null;
      let resetRetries = 3;
      
      while (resetRetries > 0 && (!resetResponse || resetResponse.status !== 'success')) {
        resetResponse = await safeSendMessage({
          action: 'resetSingleModelCounter',
          modelFullName: modelName,
          resetTimestamp: newSinceTimestamp,        // Current time as "Since" timestamp
          nextResetTime: newUntilTimestamp,         // Calculated "Until" timestamp
          limitResetTime: newUntilTimestamp         // Also set limitResetTime for compatibility
        }, { suppressErrors: true }); // Use suppressErrors for retry logic
        
        if (!resetResponse || resetResponse.status !== 'success') {
          resetRetries--;
          console.log(`ModelMeter Debug (Expiration Check): ⚠️ Reset failed for "${modelName}", ${resetRetries} retries left. Response:`, resetResponse);
          if (resetRetries > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
          }
        }
      }
      
      if (resetResponse && resetResponse.status === 'success') {
        resetsPerformed++;
        console.log(`ModelMeter Debug (Expiration Check): ✅ Successfully reset counter for "${modelName}"
          - New since time: ${new Date(newSinceTimestamp).toISOString()}
          - New until time: ${newUntilTimestamp ? new Date(newUntilTimestamp).toISOString() : 'not set'}
          - Counter reset to: 0`);
      } else {
        console.error(`ModelMeter Debug (Expiration Check): ❌ Failed to reset counter for "${modelName}" after all retries. Final response:`, resetResponse);
      }
    }
    
    // If any models were reset, update the UI
    if (resetsPerformed > 0) {
      console.log(`ModelMeter Debug (Expiration Check): 🔄 Reset ${resetsPerformed} model counters, updating UI`);
      updateUI().catch(error => {
        console.error('ModelMeter Debug (Expiration Check): Error updating UI after resets:', error);
      });
      
      if (inPagePanel && inPagePanel.style.display === 'block') {
        updateInPagePanelData().catch(error => {
          console.error('ModelMeter Debug (Expiration Check): Error updating panel after resets:', error);
        });
      }
    }
    
    console.log(`ModelMeter Debug (Expiration Check): ✅ Expiration check completed. Reset ${resetsPerformed} of ${modelsToReset.length} models.`);
  } catch (error) {
    console.error('ModelMeter Debug (Expiration Check): ❌ Error checking for expired models:', error);
    if (error.message && error.message.includes('Extension context invalidated')) {
      handleExtensionContextError('checkAndResetExpiredModels');
    }
  }
}
// --- END: Function to check and reset expired model counters --- 