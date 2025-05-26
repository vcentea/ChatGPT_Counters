// ModelMeter - background.js

importScripts('storage_utils.js'); 
importScripts('timestamp_utils.js');

console.log('ModelMeter Background: Utility scripts imported via importScripts');

// Access utilities from the global scope (self)
const { 
  getModelDataFromStorage, 
  saveModelDataToStorage, 
  incrementModelCounterInStorage, 
  getModelCountFromStorage,
  resetAllCountersInStorage,
  getUserPlanFromStorage,
  saveUserPlanToStorage
} = self.StorageUtils;

const { 
  getModelLimits, 
  findLimitObjectForModel, 
  calculateNextTimestampAfterPeriod, 
  updateFutureModelTimestamps, 
  parseWarningTimestamps 
} = self.ModelMeterUtils;

// --- Constants ---
const API_ENDPOINT = 'https://chatgpt.com/backend-api/f/conversation';
const DEBUG_API_LOGGING = true; // Set to false in production

// --- Initialization ---
chrome.runtime.onInstalled.addListener(() => {
  console.log('ModelMeter Background Debug: 🚀 Extension installed/updated.');
  
  // Initialize modelData in storage if it doesn't exist
  getModelDataFromStorage().then(data => {
    if (Object.keys(data).length === 0) {
      saveModelDataToStorage({}); // Ensures the key exists with an empty object
      console.log('ModelMeter Background Debug: 📋 Initialized empty modelData in storage.');
    } else {
      console.log('ModelMeter Background Debug: 📊 Current model data:', data);
      // Update future model timestamps on startup
      if (typeof updateFutureModelTimestamps === 'function') {
        updateFutureModelTimestamps()
          .then(updatesCount => {
            console.log(`ModelMeter Background Debug: Updated timestamps for ${updatesCount} models on startup`);
          })
          .catch(error => {
            console.error('ModelMeter Background Debug: Error updating timestamps on startup:', error);
          });
      } else {
        console.error('ModelMeter Background Debug: updateFutureModelTimestamps is not available on startup.');
      }
    }
  });
});

// Test that storage operations are working correctly (can be re-enabled for diagnostics)
/*
async function testStorageOperations() {
  console.log('ModelMeter Background Debug: 🧪 Running storage operations test...');
  try {
    const testModel = 'test-model-diagnostics';
    await incrementModelCounterInStorage(testModel);
    let count = await getModelCountFromStorage(testModel);
    console.log(`ModelMeter Background Debug: 🧪 After increment, count = ${count}`);
    // Test reset - this will be part of the new logic
    // await resetSingleModelCounterInStorage(testModel);
    // count = await getModelCountFromStorage(testModel);
    // console.log(`ModelMeter Background Debug: 🧪 After reset, count = ${count}`);
    const modelData = await getModelDataFromStorage();
    delete modelData[testModel];
    await saveModelDataToStorage(modelData);
    console.log('ModelMeter Background Debug: 🧪 Storage test complete - Everything working! ✅');
  } catch (error) {
    console.error('ModelMeter Background Debug: 🧪 Storage test failed ❌', error);
  }
}
*/

// --- Message Handling ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('ModelMeter Background Debug: 📨 Message received:', message);
  
  // --- Handle Ping (Context Validity Check) ---
  if (message.action === 'ping') {
    sendResponse({ status: 'success', message: 'Background script is responsive' });
    return true;
  }
  
  // --- Handle Health Check ---
  if (message.action === 'healthCheck') {
    sendResponse({ 
      status: 'success', 
      message: 'ModelMeter background script is healthy',
      timestamp: Date.now()
    });
    return true;
  }
  
  // --- Handle API Request Detection ---
  if (message.action === 'apiRequestDetected' && message.modelData) {
    console.log('ModelMeter Background Debug: 🔎 API request detected from content script (logging only):', message.modelData);
    // Current design does not increment based on API request alone, but on SSE/DOM events
    sendResponse({ status: 'success', message: 'API request logged by background.' });
    return true;
  }
  
  // --- Handle Model Count Increment ---
  if (message.action === 'incrementModelCount' && message.modelFullName) {
    console.log(`ModelMeter Background Debug: 🔢 Incrementing count for ${message.modelFullName}`);
    incrementModelCounterInStorage(message.modelFullName)
      .then(newCount => {
        sendResponse({ status: 'success', newCount: newCount });
      })
      .catch(error => {
        console.error(`ModelMeter Background Debug: 💥 Error incrementing count for ${message.modelFullName}:`, error);
        sendResponse({ status: 'error', message: error.message });
      });
    return true; // Indicates async response
  }
  
  // --- Handle User Plan Settings ---
  if (message.action === 'getUserPlan') {
    getUserPlanFromStorage().then(plan => {
      sendResponse({ status: 'success', plan: plan });
    });
    return true; // Indicates async response
  }
  
  if (message.action === 'setUserPlan' && message.plan) {
    saveUserPlanToStorage(message.plan).then(success => {
      sendResponse({ status: success ? 'success' : 'error' });
      // If successful, notify UI to refresh as limits might change
      if (success) {
        chrome.runtime.sendMessage({ action: 'countersDisplayShouldRefresh' }).catch(e => { /* ignore */ });
      }
    });
    return true; // Indicates async response
  }

  // --- Handle Model Data Retrieval ---
  if (message.action === 'getModelData') {
    getModelDataFromStorage().then(data => {
      sendResponse({ status: 'success', data: data });
    });
    return true; // Indicates async response
  }

  if (message.action === 'getModelCount' && message.modelFullName) {
    getModelCountFromStorage(message.modelFullName).then(count => {
      sendResponse({ status: 'success', count: count });
    });
    return true; // Indicates async response
  }
  
  // --- Handle Direct Model Data Save (used by timestamp_utils) ---
  if (message.action === 'saveModelDataDirectly' && message.modelData) {
    saveModelDataToStorage(message.modelData).then(() => {
      sendResponse({ status: 'success' });
    }).catch(error => {
      console.error('ModelMeter Background Debug: Error saving model data directly:', error);
      sendResponse({ status: 'error', message: error.message });
    });
    return true;
  }

  // --- Handle Rate Limit Hit (NEW LOGIC) ---
  if (message.action === 'rateLimitHit') {
    handleRateLimitHit(message)
      .then(() => sendResponse({ status: 'success', message: 'Rate limit data processed by background.' }))
      .catch(error => {
        console.error('ModelMeter Background Debug: 💥 Error processing rateLimitHit:', error);
        sendResponse({ status: 'error', message: `Error processing rateLimitHit: ${error.message}` });
      });
    return true; // Indicates async response
  }
  
  // --- Handle Single Model Counter Reset (Manual or Expired) ---
  if (message.action === 'resetSingleModelCounter') {
    handleSingleModelReset(message)
      .then(() => sendResponse({ status: 'success', message: `Counter for ${message.modelFullName} reset.` }))
      .catch(error => {
        console.error(`ModelMeter Background Debug: 💥 Error resetting single model counter ${message.modelFullName}:`, error);
        sendResponse({ status: 'error', message: `Error resetting counter: ${error.message}` });
      });
    return true; // Indicates async response
  }
  
  // --- Handle Reset All Counters ---
  if (message.action === 'resetAllCounters') {
    resetAllCountersInStorage()
      .then(() => {
        sendResponse({ status: 'success', message: 'All counters reset.' });
        // Notify UI to refresh
        chrome.runtime.sendMessage({ action: 'countersDisplayShouldRefresh' }).catch(e => { /* ignore */ });
      })
      .catch(error => {
        console.error('ModelMeter Background Debug: 💥 Error resetting all counters:', error);
        sendResponse({ status: 'error', message: `Error resetting all counters: ${error.message}` });
      });
    return true; // Indicates async response
  }
  
  // --- Handle Model Configuration Update (NEW) ---
  if (message.action === 'updateModelConfig') {
    handleModelConfigUpdate(message)
      .then(() => sendResponse({ status: 'success', message: `Configuration for ${message.modelName} updated.` }))
      .catch(error => {
        console.error(`ModelMeter Background Debug: 💥 Error updating configuration for ${message.modelName}:`, error);
        sendResponse({ status: 'error', message: `Error updating configuration: ${error.message}` });
      });
    return true; // Indicates async response
  }

  // Default response for unhandled message types
  sendResponse({ status: 'error', message: 'Unhandled message type' });
  return false;
});

// NEW function to handle model configuration updates
async function handleModelConfigUpdate(message) {
  const { modelName, count, untilTimestamp, userPlan } = message;
  console.log(`ModelMeter Background: Processing configuration update for ${modelName}.`);

  if (!modelName || isNaN(count) || isNaN(untilTimestamp)) {
    console.error('ModelMeter Background: Invalid data for handleModelConfigUpdate', message);
    throw new Error('Invalid data received for model configuration update.');
  }

  const modelData = await getModelDataFromStorage();
  if (!modelData[modelName]) {
    throw new Error(`Model ${modelName} not found in storage.`);
  }

  // Get model limits to calculate the lastResetTimestamp based on the new untilTimestamp
  const modelLimits = getModelLimits(userPlan);
  const modelLowerCase = modelName.toLowerCase();
  const limitObject = findLimitObjectForModel(modelName, modelLowerCase, modelLimits);

  // Update the count
  modelData[modelName].count = count;
  
  // Update the until timestamp
  modelData[modelName].nextResetTime = untilTimestamp;
  modelData[modelName].limitResetTime = untilTimestamp; // Keep consistent
  
  // Calculate and update the since timestamp (lastResetTimestamp)
  if (limitObject && limitObject.periodUnit !== 'unlimited' && limitObject.periodUnit !== 'none') {
    // For models with a period, we need to back-calculate the since timestamp
    // based on the until timestamp and the period
    
    // Create a date from the until timestamp
    const untilDate = new Date(untilTimestamp);
    
    // Calculate the since timestamp by subtracting one period
    let sinceDate = new Date(untilDate);
    
    switch(limitObject.periodUnit) {
      case 'hour':
        sinceDate.setHours(sinceDate.getHours() - limitObject.periodAmount);
        break;
      case 'day':
        sinceDate.setDate(sinceDate.getDate() - limitObject.periodAmount);
        break;
      case 'week':
        sinceDate.setDate(sinceDate.getDate() - (limitObject.periodAmount * 7));
        break;
      case 'month':
        sinceDate.setMonth(sinceDate.getMonth() - limitObject.periodAmount);
        break;
      default:
        // For unknown period units, log a warning and don't update the since timestamp
        console.warn(`ModelMeter Background: Unknown periodUnit "${limitObject.periodUnit}" for model, using current lastResetTimestamp.`);
    }
    
    modelData[modelName].lastResetTimestamp = sinceDate.getTime();
    console.log(`ModelMeter Background: Calculated new 'Since' timestamp for ${modelName}: ${new Date(modelData[modelName].lastResetTimestamp).toLocaleString()}`);
  } else {
    // For unlimited/none models, just keep the current lastResetTimestamp
    console.log(`ModelMeter Background: Model ${modelName} has no period or is unlimited. Keeping current 'Since' timestamp.`);
  }
  
  console.log(`ModelMeter Background: Updated ${modelName} configuration - Count: ${modelData[modelName].count}, Since: ${new Date(modelData[modelName].lastResetTimestamp).toLocaleString()}, Until: ${new Date(modelData[modelName].nextResetTime).toLocaleString()}`);
  
  await saveModelDataToStorage(modelData);
  console.log(`ModelMeter Background: Saved updated configuration for ${modelName}.`);
}

// NEW function to handle rate limit hits based on banner detection
async function handleRateLimitHit(message) {
  const { modelSlug, newSinceTimestampFromBanner, resetCounter, warningText } = message;
  console.log(`ModelMeter Background: Processing rateLimitHit for ${modelSlug}.`);

  if (!modelSlug) {
    console.error('ModelMeter Background: Invalid data for handleRateLimitHit', message);
    throw new Error('Invalid data received for rate limit hit.');
  }

  const modelData = await getModelDataFromStorage();
  const userPlan = await getUserPlanFromStorage();
  const modelLimits = getModelLimits(userPlan);
  const modelLowerCase = modelSlug.toLowerCase();
  const limitObject = findLimitObjectForModel(modelSlug, modelLowerCase, modelLimits);

  let newSinceTimestamp = newSinceTimestampFromBanner;
  let newUntilTimestamp = null;

  // Handle o3 warning banners with future reset dates
  if (warningText && modelLowerCase.includes('o3') && limitObject && limitObject.periodUnit === 'week') {
    console.log(`ModelMeter Background: Processing o3 warning banner text: "${warningText}"`);
    
    const timestamps = parseWarningTimestamps(warningText, modelSlug, limitObject);
    
    if (timestamps.sinceTimestamp && timestamps.untilTimestamp) {
      newSinceTimestamp = timestamps.sinceTimestamp;
      newUntilTimestamp = timestamps.untilTimestamp;
      console.log(`ModelMeter Background: Parsed o3 warning banner. New 'Start': ${new Date(newSinceTimestamp).toLocaleString()}, 'Until': ${new Date(newUntilTimestamp).toLocaleString()}`);
    }
  }
  
  // If we don't have a valid "since" timestamp or couldn't parse one from the warning banner,
  // use the provided one from the regular banner (if available) or the current time
  if (!newSinceTimestamp) {
    newSinceTimestamp = newSinceTimestampFromBanner || new Date().getTime();
    console.log(`ModelMeter Background: Using fallback 'Start' for ${modelSlug}: ${new Date(newSinceTimestamp).toLocaleString()}`);
  }

  // If we don't have a valid "until" timestamp from the warning banner parsing,
  // calculate it based on the model's period
  if (!newUntilTimestamp && limitObject) {
    newUntilTimestamp = calculateNextTimestampAfterPeriod(newSinceTimestamp, limitObject);
    console.log(`ModelMeter Background: Calculated 'Until' for ${modelSlug}: ${newUntilTimestamp ? new Date(newUntilTimestamp).toLocaleString() : 'N/A (unlimited/none)'}`);
  } else if (!newUntilTimestamp) {
    console.warn(`ModelMeter Background: No limitObject found for ${modelSlug} to calculate 'Until'. 'Until' will be null.`);
  }
  
  // Ensure the model entry exists
  if (!modelData[modelSlug]) {
    modelData[modelSlug] = { count: 0 }; // Initialize if new
  }
  
  // Update model data
  if (resetCounter) {
    modelData[modelSlug].count = 0;
  }
  modelData[modelSlug].lastResetTimestamp = newSinceTimestamp; // This is the new 'Start'
  modelData[modelSlug].nextResetTime = newUntilTimestamp;      // This is the new 'Until'
  modelData[modelSlug].limitResetTime = newUntilTimestamp;     // Keep consistent
  
  console.log(`ModelMeter Background: Updated ${modelSlug} - Start: ${new Date(modelData[modelSlug].lastResetTimestamp).toLocaleString()}, Until: ${newUntilTimestamp ? new Date(newUntilTimestamp).toLocaleString() : 'N/A'}, Count: ${modelData[modelSlug].count}`);
  
  await saveModelDataToStorage(modelData);
  console.log(`ModelMeter Background: Saved updated model data for ${modelSlug} after rate limit hit.`);
}

// NEW function to handle single model resets (manual from popup, or from expired model check)
async function handleSingleModelReset(message) {
  const { modelFullName, resetTimestamp, nextResetTime: newNextResetTimeFromMessage } = message;
  console.log(`ModelMeter Background: Processing single model reset for ${modelFullName}.`);

  if (!modelFullName) {
    console.error('ModelMeter Background: Invalid modelFullName for handleSingleModelReset');
    throw new Error('Invalid model name for reset.');
  }

  const modelData = await getModelDataFromStorage();
  const now = resetTimestamp || new Date().getTime(); // Use provided resetTimestamp or now if not given

  // Ensure the model entry exists
  if (!modelData[modelFullName]) {
    modelData[modelFullName] = {}; // Initialize if new, count will be set to 0
  }
  
  modelData[modelFullName].count = 0;
  modelData[modelFullName].lastResetTimestamp = now; // Set 'Start' to now or provided time
  
  // If a specific nextResetTime (Until) was provided (e.g., from expired check or manual reset with calculation),
  // use that. Otherwise, calculate it based on the new 'Start' (now).
  let calculatedUntil = newNextResetTimeFromMessage;
  if (typeof calculatedUntil !== 'number') { // If not provided, calculate it
      const userPlan = await getUserPlanFromStorage();
      const modelLimits = getModelLimits(userPlan);
      const modelLowerCase = modelFullName.toLowerCase();
      const limitObject = findLimitObjectForModel(modelFullName, modelLowerCase, modelLimits);
      if (limitObject) {
          calculatedUntil = calculateNextTimestampAfterPeriod(now, limitObject);
      }
  }
  
  modelData[modelFullName].nextResetTime = calculatedUntil;
  modelData[modelFullName].limitResetTime = calculatedUntil; // Keep consistent
  
  console.log(`ModelMeter Background: Reset ${modelFullName} - Start: ${new Date(now).toLocaleString()}, Until: ${calculatedUntil ? new Date(calculatedUntil).toLocaleString() : 'N/A'}, Count: 0`);

  await saveModelDataToStorage(modelData);
  console.log(`ModelMeter Background: Saved updated model data for ${modelFullName} after single reset.`);
}

// Helper to send messages to tabs with retries (useful if content script isn't ready immediately)
function sendMessageToTabWithRetries(tabId, message, retriesLeft) {
  if (retriesLeft <= 0) {
    console.warn(`ModelMeter Background: Max retries reached for sending message to tab ${tabId}:`, message);
    return;
  }
  chrome.tabs.sendMessage(tabId, message)
    .then(response => {
      if (response && response.status === 'success') {
        console.log(`ModelMeter Background: Message successfully sent to tab ${tabId} after ${3 - retriesLeft + 1} attempt(s):`, message);
      } else {
        // If no success response or an error-like response without throwing, retry.
        console.warn(`ModelMeter Background: Tab ${tabId} responded, but not with success (attempt ${3-retriesLeft+1}/3), retrying:`, response);
        setTimeout(() => sendMessageToTabWithRetries(tabId, message, retriesLeft - 1), 1000);
      }
    })
    .catch(err => {
      console.warn(`ModelMeter Background: Error sending message to tab ${tabId} (attempt ${3-retriesLeft+1}/3), retrying: ${err.message}`);
      setTimeout(() => sendMessageToTabWithRetries(tabId, message, retriesLeft - 1), 1000);
    });
}

console.log('ModelMeter Background: Service Worker started and listeners initialized.');