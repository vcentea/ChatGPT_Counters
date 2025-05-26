// Simple popup script for ModelMeter

document.addEventListener('DOMContentLoaded', function() {
  console.log('ModelMeter Popup: Loaded');
  setupEventListeners();
  updateConnectionStatus(); // This also pings content script for current model
  updateCountersDisplay();  // Fetch and display all model counts

  // Listen for messages from background script (e.g., after a reset)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'countersDisplayShouldRefresh') {
      console.log('ModelMeter Popup: Received request to refresh counters display');
      updateCountersDisplay();
    }
  });
});

function setupEventListeners() {
  document.querySelector('#refreshButton')?.addEventListener('click', function() {
    console.log('ModelMeter Popup: Refresh button clicked');
    updateConnectionStatus();
    updateCountersDisplay();
  });

  // Add event listener for Reset All button
  document.querySelector('#resetButton')?.addEventListener('click', function() {
    if (confirm('Are you sure you want to reset all model counters?')) {
      chrome.runtime.sendMessage({ action: 'resetAllCounters' }).then(response => {
        if (response && response.status === 'success') {
          updateStatus('All counters reset.', 'success');
          updateCountersDisplay();
        } else {
          updateStatus('Failed to reset counters.', 'error');
        }
      }).catch(error => {
        updateStatus('Error resetting counters.', 'error');
        console.error('ModelMeter Popup: Error during reset all:', error);
      });
    }
  });

  // Configuration Modal event listeners
  document.querySelector('#cancelConfig')?.addEventListener('click', function() {
    hideConfigModal();
  });

  document.querySelector('#configForm')?.addEventListener('submit', function(event) {
    event.preventDefault();
    saveModelConfig();
  });
}

function updateConnectionStatus() {
  const statusElement = document.querySelector('#status');
  if (!statusElement) return;
  statusElement.textContent = 'Checking connection...';

  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (chrome.runtime.lastError || !tabs || !tabs[0]) {
      updateStatus('Unable to access current tab. Try again.', 'error');
      console.error('ModelMeter Popup: Error querying tabs:', chrome.runtime.lastError);
      return;
    }
    
    const tab = tabs[0];
    if (!tab.url || !tab.url.includes('chatgpt.com')) {
      updateStatus('Not on ChatGPT. Please navigate to chatgpt.com', 'warning');
      return;
    }
    
    // Send ping with retries
    sendPingWithRetries(tab.id, { action: 'ping' }, 3);
  });
}

function sendPingWithRetries(tabId, message, retriesLeft) {
  if (retriesLeft <= 0) {
    updateStatus('Content script not responding. Try refreshing the ChatGPT page.', 'error');
    console.error('ModelMeter Popup: Max retries reached for pinging content script on tab', tabId);
    return;
  }

  chrome.tabs.sendMessage(tabId, message)
    .then(response => {
      if (response && response.status === 'success') {
        updateStatus(`Connected! Current model on page: ${response.model || 'Unknown'}`, 'success');
      } else {
        console.warn(`ModelMeter Popup: Ping attempt ${4 - retriesLeft}/3 to tab ${tabId} got unexpected response:`, response, "Retrying...");
        setTimeout(() => sendPingWithRetries(tabId, message, retriesLeft - 1), 500);
      }
    })
    .catch(error => {
      console.warn(`ModelMeter Popup: Ping attempt ${4 - retriesLeft}/3 to tab ${tabId} failed: ${error.message}. Retrying...`);
      setTimeout(() => sendPingWithRetries(tabId, message, retriesLeft - 1), 500);
    });
}

async function updateCountersDisplay() {
  const countersElement = document.querySelector('#counters');
  if (!countersElement) return;
  countersElement.innerHTML = '<div class="no-data">Loading counts...</div>'; 

  try {
    const response = await chrome.runtime.sendMessage({ action: 'getModelData' });
    if (response && response.status === 'success' && response.data) {
      const modelData = response.data; // Keys are raw model names
      countersElement.innerHTML = ''; 

      const modelKeys = Object.keys(modelData);
      if (modelKeys.length === 0) {
        countersElement.innerHTML = '<div class="no-data">No model usage data yet. Start chatting!</div>';
        return;
      }

      modelKeys.sort().forEach(modelFullName => {
        const item = modelData[modelFullName];
        const countElement = document.createElement('div');
        countElement.className = 'count-display';
        
        const resetDateTime = new Date(item.lastResetTimestamp).toLocaleString(undefined, { 
          year: 'numeric', month: 'short', day: 'numeric', 
          hour: '2-digit', minute: '2-digit' 
        });

        // Calculate expiration date (until) if available
        let untilDateTime = '';
        if (item.nextResetTime) {
          untilDateTime = new Date(item.nextResetTime).toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
          });
        }

        // Display the raw model name directly
        const displayName = modelFullName; 

        countElement.innerHTML = `
          <div class="model-details">
            <div class="model-info">
              <span class="model-name">${displayName}</span>
              <span class="reset-timestamp">Since: ${resetDateTime}</span>
              ${untilDateTime ? `<span class="reset-timestamp">Until: ${untilDateTime}</span>` : ''}
            </div>
          </div>
          <div class="count-actions">
            <span class="count">${item.count}</span>
            <button class="config-btn" data-model="${modelFullName}" title="Configure ${displayName}">Config</button>
            <button class="reset-single-btn" data-model="${modelFullName}" title="Reset count for ${displayName}">Reset</button>
          </div>
        `;
        countersElement.appendChild(countElement);

        // Add event listener for config button
        const configButton = countElement.querySelector('.config-btn');
        configButton?.addEventListener('click', function() {
          const modelToConfig = this.getAttribute('data-model');
          showConfigModal(modelToConfig, modelData[modelToConfig]);
        });

        const singleResetButton = countElement.querySelector('.reset-single-btn');
        singleResetButton?.addEventListener('click', async function() {
          const modelToReset = this.getAttribute('data-model'); // This is raw modelFullName
          if (modelToReset && confirm(`Are you sure you want to reset the count for ${modelToReset}?`)) { // Use raw name in confirm
            try {
              const resetResponse = await chrome.runtime.sendMessage({
                action: 'resetSingleModelCounter',
                modelFullName: modelToReset // Send raw name
              });
              if (resetResponse && resetResponse.status === 'success') {
                updateStatus(`Count for ${modelToReset} reset.`, 'success'); // Use raw name in status
                updateCountersDisplay();
              } else {
                updateStatus(`Failed to reset ${modelToReset}.`, 'error'); // Use raw name in status
              }
            } catch (error) {
              updateStatus(`Error resetting ${modelToReset}.`, 'error'); // Use raw name in status
              console.error('ModelMeter Popup: Error during single reset:', error);
            }
          }
        });
      });
    } else {
      countersElement.innerHTML = '<div class="no-data error">Failed to load model data.</div>';
      console.error('ModelMeter Popup: Failed to get model data', response);
    }
  } catch (error) {
    countersElement.innerHTML = '<div class="no-data error">Error loading model data.</div>';
    console.error('ModelMeter Popup: Error fetching model data:', error);
  }
}

function updateStatus(message, type) {
  const statusElement = document.querySelector('#status');
  if (!statusElement) return;
  statusElement.textContent = message;
  statusElement.className = `status ${type || ''}`;
}

// Configuration Modal Functions
function showConfigModal(modelName, modelData) {
  console.log('ModelMeter Popup: Opening configuration for model:', modelName, modelData);
  
  // Set the model name in the hidden field
  document.getElementById('configModelName').value = modelName;
  
  // Set the current count
  document.getElementById('configCount').value = modelData.count || 0;
  
  // Set the expiration date (until) if available
  const expireDate = modelData.nextResetTime ? new Date(modelData.nextResetTime) : new Date();
  
  // Format date to yyyy-MM-ddThh:mm
  const formattedDate = expireDate.toISOString().slice(0, 16);
  document.getElementById('configExpireDate').value = formattedDate;
  
  // Show the modal
  document.getElementById('configModal').classList.add('visible');
}

function hideConfigModal() {
  document.getElementById('configModal').classList.remove('visible');
}

async function saveModelConfig() {
  const modelName = document.getElementById('configModelName').value;
  const count = parseInt(document.getElementById('configCount').value);
  const expireDate = new Date(document.getElementById('configExpireDate').value).getTime();
  
  if (!modelName || isNaN(count) || isNaN(expireDate)) {
    updateStatus('Invalid configuration data.', 'error');
    return;
  }

  try {
    // Get current model data
    const response = await chrome.runtime.sendMessage({ action: 'getModelData' });
    if (!response || response.status !== 'success' || !response.data) {
      updateStatus('Failed to get model data for configuration.', 'error');
      return;
    }

    const modelData = response.data;
    if (!modelData[modelName]) {
      updateStatus(`Model ${modelName} not found.`, 'error');
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
      updateStatus(`Configuration for ${modelName} updated.`, 'success');
      hideConfigModal();
      updateCountersDisplay();
    } else {
      updateStatus(`Failed to update configuration for ${modelName}.`, 'error');
    }
  } catch (error) {
    updateStatus(`Error saving configuration: ${error.message}`, 'error');
    console.error('ModelMeter Popup: Error saving model configuration:', error);
  }
}

// sendMessageToContentScript and injectContentScript are no longer needed here as background handles injection
// and content script directly communicates with background for counts. 