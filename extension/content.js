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

// Constants
const API_ENDPOINTS = [
  'https://chatgpt.com/backend-api/f/conversation',
  'https://chatgpt.com/backend-api/conversation',
  'https://chatgpt.com/backend-api/v1/conversation',
];
// Add the specific endpoint known to use SSE for conversation details
const SSE_ENDPOINT_FRAGMENT = '/backend-api/conversation'; // More general check for SSE endpoint

// Wait for DOM to be ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  initialize();
} else {
  document.addEventListener('DOMContentLoaded', initialize);
}

// Ensure the timestamp_utils.js script is loaded
function loadTimestampUtils() {
  return new Promise((resolve, reject) => {
    // Check if the function is already available
    if (typeof window.updateFutureModelTimestamps === 'function') {
      resolve();
      return;
    }

    // Create script element to load the file
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('timestamp_utils.js');
    script.onload = () => {
      console.log('ModelMeter: Timestamp utils loaded successfully');
      resolve();
    };
    script.onerror = (error) => {
      console.error('ModelMeter: Failed to load timestamp utils', error);
      reject(error);
    };
    document.head.appendChild(script);
  });
}

// Initialize the extension
async function initialize() {
  if (isModelMeterInitialized) {
    console.log('ModelMeter Content: Already initialized, skipping.');
    return;
  }
  
  try {
    // Load timestamp utils first
    await loadTimestampUtils();
    
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
      
      // Set up regular checks for banners and expired models
      setInterval(() => {
        checkAndParseRateLimitBanner();
        checkAndResetExpiredModels();
      }, 60000); // Check every minute
    }, 1000);
    
    console.log('ModelMeter Content: Initialized successfully');
  } catch (error) {
    console.error('ModelMeter Content: Initialization failed', error);
    isModelMeterInitialized = false;
    if (error.message && error.message.includes('Extension context invalidated')) {
      handleExtensionContextError('initialize');
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
   chrome.runtime.sendMessage({
       action: 'incrementModelCount',
       modelFullName: modelSlug // background expects modelFullName
   }).then(response => {
       if (response && response.status === 'success') {
           console.log(`ModelMeter Content: Background confirmed increment for model: ${modelSlug}`);
           // Immediately update all UI components to keep in sync
           updateAllUIComponents();
       } else {
           console.error(`ModelMeter Content: Background failed increment for ${modelSlug}`, response);
       }
   }).catch(err => {
       console.error(`ModelMeter Content: Error sending increment for ${modelSlug} to background:`, err);
       if (err.message && err.message.includes('Extension context invalidated')) {
           handleExtensionContextError('incrementCounterInBackground');
       }
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
          'o3': { count: 100, periodAmount: 1, periodUnit: 'week', displayText: '50 per week' },
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
            <div style="width:50px; text-align:right;">
            <button class="inpage-reset-single" data-model="${modelFullName}" style="padding:2px 5px; font-size:9px; background:#dc3545; color:white; border:none; border-radius:3px; cursor:pointer;">Reset</button>
          </div>
        `;
        countersEl.appendChild(itemDiv);
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
      console.log('ModelMeter: Document became visible, refreshing data');
      detectCurrentModel();
      updateUI();
      
      // Check for rate limit banners and expired models when tab becomes visible
      checkAndParseRateLimitBanner();
      checkAndResetExpiredModels();
    }
  });
  
  console.log('ModelMeter: Visibility change detection set up');
}

// Update the UI bubble with raw model name AND ITS COUNT
async function updateUI() { // Bubble UI
  if (!uiInitialized || !bubbleElement) return;
  
  // Display raw currentModel or '??' if null
  const displayName = currentModel || '??';
  let count = 0;

  if (currentModel) { // currentModel is the raw name/slug
    try {
      console.log(`ModelMeter Content: Getting count for raw model: ${currentModel}`);
      const response = await chrome.runtime.sendMessage({ action: 'getModelCount', modelFullName: currentModel });
      if (response && response.status === 'success') {
        count = response.count;
      } else {
        console.error('ModelMeter Content: Failed to get model count from background for', currentModel, response);
      }
    } catch (error) {
      console.error('ModelMeter Content: Error fetching model count for', currentModel, error);
      if (error.message && error.message.includes('Extension context invalidated')) {
        handleExtensionContextError('updateUI');
        return; // Don't update the bubble if we have a context error
      }
    }
  }
  
  try {
    // Only update if the element still exists and we haven't been invalidated
    if (bubbleElement && document.body.contains(bubbleElement)) {
      bubbleElement.textContent = `${displayName} · ${count}`;
    }
  } catch (error) {
    console.error('ModelMeter Content: Error updating bubble text:', error);
  }
}

// At around line 45, add this function to handle extension context errors
function handleExtensionContextError(source) {
    console.error(`ModelMeter Content: Extension context invalidated during ${source}. Refresh needed.`);
    const errorMessage = document.createElement('div');
    errorMessage.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #ff4444;
        color: white;
        padding: 15px;
        border-radius: 8px;
        z-index: 10000;
        box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        font-family: system-ui;
        max-width: 300px;
    `;
    errorMessage.innerHTML = `
        <strong>ModelMeter Extension Error</strong><br>
        Please refresh the page to restore functionality.<br>
        <small>The extension needs to reconnect to track model usage.</small>
    `;
    document.body.appendChild(errorMessage);
    setTimeout(() => errorMessage.remove(), 10000);
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
    });
    console.log('ModelMeter Content: Outside click handler set up for panel');
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
  console.log('ModelMeter Debug: Checking for models with expired reset times...');
  try {
    // Get current model data from storage
    const response = await chrome.runtime.sendMessage({ action: 'getModelData' });
    if (!response || response.status !== 'success' || !response.data) {
      console.error('ModelMeter Debug: Failed to get model data for reset check');
      return;
    }

    const modelData = response.data;
    const now = new Date().getTime();
    let resetsPerformed = 0;

    // Check each model to see if its reset time has passed
    for (const [modelName, modelInfo] of Object.entries(modelData)) {
      // Check either nextResetTime or limitResetTime property
      const nextResetTime = modelInfo.nextResetTime || modelInfo.limitResetTime;
      
      if (nextResetTime && now >= nextResetTime) {
        console.log(`ModelMeter Debug: Reset time passed for ${modelName}, resetting counter. Reset time was: ${new Date(nextResetTime).toLocaleString()}`);
        
        // Reset counter for this model and calculate new reset time
        try {
          // Get model limit info to calculate the next reset time
          const planResponse = await chrome.runtime.sendMessage({ action: 'getUserPlan' });
          const currentPlan = (planResponse && planResponse.status === 'success') ? planResponse.plan : 'FREE';
          
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
          
          // Find the limit object for this model
          const modelLowerCase = modelName.toLowerCase();
          let limitObject = null;
          
          // Try to find by model name
          if (modelLimits[modelName]) {
            limitObject = modelLimits[modelName];
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
          
          // Get current timestamp to use as the "Since" timestamp
          const resetTimestamp = now;
          
          // Calculate the next reset time based on current time (not the expired reset time)
          let calculatedNextResetTime = null;
          if (limitObject && limitObject.periodUnit !== 'unlimited' && limitObject.periodUnit !== 'none') {
            // Always calculate from now, since the previous reset time has expired
            let newResetDate = new Date(now);
            
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
                break;
            }
            
            calculatedNextResetTime = newResetDate.getTime();
            console.log(`ModelMeter Debug: New reset time for ${modelName}: ${new Date(calculatedNextResetTime).toISOString()} (${limitObject.periodAmount} ${limitObject.periodUnit}(s) from now)`);
          }
          
          // Reset the counter and update both timestamps
          // Set both nextResetTime and limitResetTime for compatibility
          const resetResponse = await chrome.runtime.sendMessage({
            action: 'resetSingleModelCounter',
            modelFullName: modelName,
            resetTimestamp: resetTimestamp,           // Current time as "Since" timestamp
            nextResetTime: calculatedNextResetTime,   // Calculated "Until" timestamp
            limitResetTime: calculatedNextResetTime   // Also set limitResetTime for compatibility
          });
          
          if (resetResponse && resetResponse.status === 'success') {
            resetsPerformed++;
            console.log(`ModelMeter Debug: Successfully reset counter for ${modelName}, next reset at ${calculatedNextResetTime ? new Date(calculatedNextResetTime).toISOString() : 'not set'}`);
  } else {
            console.error(`ModelMeter Debug: Failed to reset counter for ${modelName}`);
          }
        } catch (error) {
          console.error(`ModelMeter Debug: Error resetting counter for ${modelName}:`, error);
          if (error.message && error.message.includes('Extension context invalidated')) {
            handleExtensionContextError('resetExpiredModels');
          }
        }
      }
    }
    
    // If any models were reset, update the UI
    if (resetsPerformed > 0) {
      console.log(`ModelMeter Debug: Reset ${resetsPerformed} model counters, updating UI`);
      updateUI();
      if (inPagePanel && inPagePanel.style.display === 'block') {
        updateInPagePanelData();
      }
    }
  } catch (error) {
    console.error('ModelMeter Debug: Error checking for expired models:', error);
    if (error.message && error.message.includes('Extension context invalidated')) {
      handleExtensionContextError('checkAndResetExpiredModels');
    }
  }
}
// --- END: Function to check and reset expired model counters --- 