// ModelMeter - background.js

// Import utilities
import * as StorageUtils from './storage_utils.js';
const { 
  getModelDataFromStorage, 
  saveModelDataToStorage, 
  incrementModelCounterInStorage, 
  getModelCountFromStorage,
  resetAllCountersInStorage,
  getUserPlanFromStorage,
  saveUserPlanToStorage
  // resetSingleModelCounterInStorage is handled by the new handleRateLimit logic
} = StorageUtils;

// Import timestamp calculation utilities
import { getModelLimits, findLimitObjectForModel, calculateNextTimestampAfterPeriod, updateFutureModelTimestamps } from './timestamp_utils.js';

console.log('ModelMeter Background: storage_utils.js and timestamp_utils.js imported as modules');

// --- Constants ---
const API_ENDPOINT = 'https://chatgpt.com/backend-api/f/conversation';
const DEBUG_API_LOGGING = true; // Set to false in production

// --- Initialization ---
chrome.runtime.onInstalled.addListener(() => {
  console.log('ModelMeter Background Debug: 🚀 Extension installed/updated.');
  setupMidnightReset();
  
  // Initialize modelData in storage if it doesn't exist
  getModelDataFromStorage().then(data => {
    if (Object.keys(data).length === 0) {
      saveModelDataToStorage({}); // Ensures the key exists with an empty object
      console.log('ModelMeter Background Debug: 📋 Initialized empty modelData in storage.');
      
      // Run a diagnostic test for storage operations
      // testStorageOperations(); // Disabled for now, can be re-enabled if needed
    } else {
      console.log('ModelMeter Background Debug: 📊 Current model data:', data);
      // Update future model timestamps on startup
      updateFutureModelTimestamps()
        .then(updatesCount => {
          console.log(`ModelMeter Background Debug: Updated timestamps for ${updatesCount} models on startup`);
        })
        .catch(error => {
          console.error('ModelMeter Background Debug: Error updating timestamps on startup:', error);
        });
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

  // Default response if no action matched
  // sendResponse({ status: 'error', message: 'Unknown action' });
  return false; // Let other listeners have a chance if action not recognized
});

// NEW function to handle rate limit hits based on banner detection
async function handleRateLimitHit(message) {
  const { modelSlug, newSinceTimestampFromBanner, resetCounter } = message;
  console.log(`ModelMeter Background: Processing rateLimitHit for ${modelSlug}. New 'Start' from banner: ${new Date(newSinceTimestampFromBanner).toLocaleString()}`);

  if (!modelSlug || typeof newSinceTimestampFromBanner !== 'number') {
    console.error('ModelMeter Background: Invalid data for handleRateLimitHit', message);
    throw new Error('Invalid data received for rate limit hit.');
  }

  const modelData = await getModelDataFromStorage();
  const userPlan = await getUserPlanFromStorage();
  const modelLimits = getModelLimits(userPlan);
  const modelLowerCase = modelSlug.toLowerCase();
  const limitObject = findLimitObjectForModel(modelSlug, modelLowerCase, modelLimits);

  let newUntilTimestamp = null;
  if (limitObject) {
    newUntilTimestamp = calculateNextTimestampAfterPeriod(newSinceTimestampFromBanner, limitObject);
    console.log(`ModelMeter Background: Calculated new 'Until' for ${modelSlug}: ${newUntilTimestamp ? new Date(newUntilTimestamp).toLocaleString() : 'N/A (unlimited/none)'}`);
  } else {
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
  modelData[modelSlug].lastResetTimestamp = newSinceTimestampFromBanner; // This is the new 'Start'
  modelData[modelSlug].nextResetTime = newUntilTimestamp;           // This is the new 'Until'
  modelData[modelSlug].limitResetTime = newUntilTimestamp;          // Keep consistent
  
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

// --- Alarm Management (Daily Reset) ---
const DAILY_RESET_ALARM_NAME = 'dailyModelMeterReset';

function setupMidnightReset() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const msUntilMidnight = midnight.getTime() - now.getTime();

  chrome.alarms.get(DAILY_RESET_ALARM_NAME, (existingAlarm) => {
    if (existingAlarm) {
        console.log('ModelMeter Background: Daily reset alarm already exists.');
    } else {
        chrome.alarms.create(DAILY_RESET_ALARM_NAME, {
            when: Date.now() + msUntilMidnight,
            periodInMinutes: 24 * 60 
        });
        console.log(`ModelMeter Background: Scheduled daily reset for ${midnight.toLocaleString()}`);
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAILY_RESET_ALARM_NAME) {
    console.log('ModelMeter Background: Daily reset alarm triggered.');
    resetAllCountersInStorage().then(() => {
        // Run timestamp update check after daily reset
        updateFutureModelTimestamps()
          .then(updatesCount => {
            console.log(`ModelMeter Background: Updated timestamps for ${updatesCount} models during daily reset`);
          })
          .catch(error => {
            console.error('ModelMeter Background: Error updating timestamps during daily reset:', error);
          });

        // Notify popup to refresh its display after daily reset
        chrome.runtime.sendMessage({ action: 'countersDisplayShouldRefresh' }).catch(e => { /* ignore if popup not open */ });
        // Also notify content script for in-page UI refresh if open
        chrome.tabs.query({url: "*://chatgpt.com/*"}, (tabs) => {
          tabs.forEach(tab => {
            if (tab.id) {
              sendMessageToTabWithRetries(tab.id, {action: 'countersDisplayShouldRefresh'}, 3);
            }
          });
        });
        console.log('ModelMeter Background: Daily reset complete, UI refresh messages sent.');
    });
  }
});

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