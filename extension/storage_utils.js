// ModelMeter - storage_utils.js
// Uses raw model names as keys in storage, e.g., "gpt-4o", "o4-mini"

console.log('ModelMeter Storage Debug: 📚 Storage utils loaded (using raw model names as keys)');

export const MODEL_DATA_KEY = 'modelData';

// No longer needed - using raw names
// function normalizeModelName(modelName) { ... }

export async function getModelDataFromStorage() {
  try {
    console.log('ModelMeter Storage Debug: 🔍 Getting all model data from storage...');
    const data = await chrome.storage.local.get(MODEL_DATA_KEY);
    const modelData = data[MODEL_DATA_KEY] || {};
    console.log('ModelMeter Storage Debug: 📊 Retrieved model data:', modelData);
    return modelData;
  } catch (error) {
    console.error('ModelMeter Storage Debug: ❌ Error getting model data:', error);
    return {};
  }
}

export async function saveModelDataToStorage(modelData) {
  try {
    console.log('ModelMeter Storage Debug: 💾 Saving model data to storage:', modelData);
    await chrome.storage.local.set({ [MODEL_DATA_KEY]: modelData });
    console.log('ModelMeter Storage Debug: ✅ Model data saved successfully');
  } catch (error) {
    console.error('ModelMeter Storage Debug: ❌ Error saving model data:', error);
  }
}

export async function incrementModelCounterInStorage(modelFullName) {
  if (!modelFullName) {
    console.error('ModelMeter Storage Debug: ❌ Cannot increment counter - modelFullName is empty/null');
    return;
  }
  
  console.log(`ModelMeter Storage Debug: 🔢 Incrementing counter for model: ${modelFullName}`);
  // Using modelFullName directly as the key
  const modelData = await getModelDataFromStorage();
  
  if (!modelData[modelFullName]) {
    console.log(`ModelMeter Storage Debug: 🆕 Creating new entry for model: ${modelFullName}`);
    modelData[modelFullName] = { count: 0, lastResetTimestamp: Date.now() };
  }
  
  modelData[modelFullName].count += 1;
  const newCount = modelData[modelFullName].count;
  
  await saveModelDataToStorage(modelData);
  console.log(`ModelMeter Storage Debug: ✅ Incremented count for ${modelFullName} to ${newCount}`);
  
  return newCount; // Return the new count for convenience
}

export async function getModelCountFromStorage(modelFullName) {
  if (!modelFullName) {
    console.warn('ModelMeter Storage Debug: ⚠️ Cannot get count - modelFullName is empty/null');
    return 0;
  }
  
  console.log(`ModelMeter Storage Debug: 🔍 Getting count for: ${modelFullName}`);
  // Using modelFullName directly as the key
  const modelData = await getModelDataFromStorage();
  const count = modelData[modelFullName]?.count || 0;
  console.log(`ModelMeter Storage Debug: 📊 Count for ${modelFullName}: ${count}`);
  return count;
}

export async function resetAllCountersInStorage() {
  console.log('ModelMeter Storage Debug: 🗑️ Resetting all counters...');
  const modelData = await getModelDataFromStorage();
  const now = Date.now();
  
  let resetCount = 0;
  for (const modelKey in modelData) { // modelKey is a raw model name
    modelData[modelKey].count = 0;
    modelData[modelKey].lastResetTimestamp = now;
    resetCount++;
  }
  
  await saveModelDataToStorage(modelData);
  console.log(`ModelMeter Storage Debug: ✅ All counters reset (${resetCount} models)`);
}

export async function resetSingleModelCounterInStorage(modelFullName) {
  if (!modelFullName) {
    console.warn('ModelMeter Storage Debug: ⚠️ Cannot reset - modelFullName is empty/null');
    return false;
  }
  
  console.log(`ModelMeter Storage Debug: 🗑️ Resetting counter for: ${modelFullName}`);
  // Using modelFullName directly as the key
  const modelData = await getModelDataFromStorage();
  if (modelData[modelFullName]) {
    modelData[modelFullName].count = 0;
    modelData[modelFullName].lastResetTimestamp = Date.now();
    await saveModelDataToStorage(modelData);
    console.log(`ModelMeter Storage Debug: ✅ Counter reset for ${modelFullName}`);
    return true;
  } else {
    console.warn(`ModelMeter Storage Debug: ⚠️ Model ${modelFullName} not found, nothing to reset`);
    return false;
  }
}

// Ensure functions are available if this script is imported via importScripts()
// No explicit export needed for service worker importScripts() pattern.

// --- NEW --- Get User Plan from Storage
export async function getUserPlanFromStorage() {
  try {
    const result = await chrome.storage.local.get('userPlan');
    console.log('ModelMeter Storage Debug: 🔍 Retrieved user plan:', result.userPlan);
    return result.userPlan || 'FREE'; // Default to FREE if not set
  } catch (error) {
    console.error('ModelMeter Storage Error: Failed to get user plan', error);
    return 'FREE'; // Return default on error
  }
}

// --- NEW --- Save User Plan to Storage
export async function saveUserPlanToStorage(plan) {
  if (plan !== 'FREE' && plan !== 'PLUS') {
    console.error('ModelMeter Storage Error: Invalid plan value provided:', plan);
    return false;
  }
  try {
    await chrome.storage.local.set({ userPlan: plan });
    console.log(`ModelMeter Storage Debug: ✅ Saved user plan: ${plan}`);
    return true;
  } catch (error) {
    console.error(`ModelMeter Storage Error: Failed to save user plan "${plan}"`, error);
    return false;
  }
} 