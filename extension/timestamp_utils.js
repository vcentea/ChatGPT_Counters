// Utility functions for handling model timestamps and quota periods

/**
 * Updates model timestamps for models without active banners but with valid future "Until" timestamps.
 * This allows timestamps to roll forward properly even without seeing a rate limit banner.
 * 
 * @returns {Promise<number>} Number of models whose timestamps were updated
 */
export async function updateFutureModelTimestamps() {
  console.log('ModelMeter: Checking for models with future reset times that need timestamp updates...');
  try {
    // Get current model data from storage
    const response = await chrome.runtime.sendMessage({ action: 'getModelData' });
    if (!response || response.status !== 'success' || !response.data) {
      console.error('ModelMeter: Failed to get model data for timestamp update check');
      return 0;
    }

    // Get current user plan to determine quota periods
    const planResponse = await chrome.runtime.sendMessage({ action: 'getUserPlan' });
    const currentPlan = (planResponse && planResponse.status === 'success') ? planResponse.plan : 'FREE';
    
    // Define model limits based on user plan
    const modelLimits = getModelLimits(currentPlan);
    
    const modelData = response.data;
    const now = new Date().getTime();
    let updatesPerformed = 0;

    // Check each model to see if its "Until" timestamp is in the future
    for (const [modelName, modelInfo] of Object.entries(modelData)) {
      // Get the reset time from either property
      const resetTime = modelInfo.nextResetTime || modelInfo.limitResetTime;
      
      // Only process models with future reset times
      if (resetTime && resetTime > now) {
        // Find the limit object for this model to determine its period
        const modelLowerCase = modelName.toLowerCase();
        let limitObject = findLimitObjectForModel(modelName, modelLowerCase, modelLimits);
        
        if (!limitObject) {
          console.log(`ModelMeter: No quota information found for model ${modelName}, skipping update`);
          continue;
        }
        
        // For models with unlimited or none period, we might still update if 'Start' is very old,
        // but their 'Until' won't be period-based.
        // The core logic is to advance 'Start' if a period has passed.
        
        // Get the last reset timestamp (or use a default if not set)
        const lastResetTimestamp = modelInfo.lastResetTimestamp || (now - (24 * 60 * 60 * 1000)); // Default to 24h ago
        
        // Check if we need to update the "Start" timestamp
        // We update if the current "Start" timestamp plus period is less than the "Until" timestamp
        // or if the model is unlimited/none and 'Start' is simply too old relative to 'now'.
        let nextPeriodStart = lastResetTimestamp; // Initialize with current "Start"
        if (limitObject.periodUnit !== 'unlimited' && limitObject.periodUnit !== 'none') {
            nextPeriodStart = calculateNextTimestampAfterPeriod(lastResetTimestamp, limitObject);
            // If the calculated next period start is still in the past, keep adding periods until we get to the future
            // but ensure it doesn't exceed the existing resetTime (banner 'Until') if that's earlier.
            while (nextPeriodStart < now && nextPeriodStart < resetTime) {
              nextPeriodStart = calculateNextTimestampAfterPeriod(nextPeriodStart, limitObject);
            }
            // If nextPeriodStart went beyond resetTime, it means the banner 'Until' is more relevant or period is too long.
            // We only want to advance 'Start' if a full period has demonstrably passed before 'now' and before 'resetTime'.
            if (nextPeriodStart >= resetTime && resetTime > lastResetTimestamp) {
                 // If advancing period by period steps over the known `resetTime` (e.g. banner `Until`),
                 // it means `resetTime` is the effective cap for this cycle.
                 // We should not advance `lastResetTimestamp` beyond what `resetTime` implies.
                 // This scenario suggests `lastResetTimestamp` is already consistent or `resetTime` is the guiding limit.
                 // So, if the period calculation would push `nextPeriodStart` past `resetTime`,
                 // then no change to `lastResetTimestamp` should be made based on this period logic here.
                 // Let `nextPeriodStart` be `lastResetTimestamp` to indicate no change.
                 nextPeriodStart = lastResetTimestamp;
            }
        } else {
            // For unlimited/none models, we don't advance 'Start' based on period.
            // Their 'Start' updates upon actual reset (banner or manual).
            // So, no change to nextPeriodStart from lastResetTimestamp.
            nextPeriodStart = lastResetTimestamp;
        }
        
        // Only update if the calculated timestamp is different from the current one
        // and nextPeriodStart must be greater than lastResetTimestamp to ensure forward progress
        if (nextPeriodStart > lastResetTimestamp && nextPeriodStart < now) {
          console.log(`ModelMeter: Updating "Start" timestamp for ${modelName} from ${new Date(lastResetTimestamp).toLocaleString()} to ${new Date(nextPeriodStart).toLocaleString()}`);
          
          const newSinceTimestamp = nextPeriodStart;
          // Calculate new "Until" based on the new "Start"
          const newUntilTimestamp = calculateNextTimestampAfterPeriod(newSinceTimestamp, limitObject);

          modelData[modelName] = {
            ...modelData[modelName],
            lastResetTimestamp: newSinceTimestamp, // New "Start"
            nextResetTime: newUntilTimestamp,      // New "Until" calculated from new "Start"
            limitResetTime: newUntilTimestamp    // Also update limitResetTime for consistency
          };
          
          if (newUntilTimestamp) {
            console.log(`ModelMeter: New "Until" for ${modelName} set to ${new Date(newUntilTimestamp).toLocaleString()}`);
          } else {
            console.log(`ModelMeter: New "Until" for ${modelName} (period: ${limitObject.periodUnit}) set to null.`);
          }
          
          updatesPerformed++;
        }
      }
    }
    
    // If any updates were performed, save the model data
    if (updatesPerformed > 0) {
      console.log(`ModelMeter: Updated timestamps for ${updatesPerformed} models, saving to storage`);
      
      // Save the updated data directly
      const saveResponse = await chrome.runtime.sendMessage({
        action: 'saveModelDataDirectly',
        modelData: modelData
      });
      
      if (saveResponse && saveResponse.status === 'success') {
        console.log('ModelMeter: Successfully saved updated model timestamps');
      } else {
        console.error('ModelMeter: Failed to save updated model timestamps');
      }
      
      // Refresh the UI to reflect the changes
      chrome.runtime.sendMessage({ 
        action: 'countersDisplayShouldRefresh'
      });
    } else {
      console.log('ModelMeter: No model timestamps needed updating');
    }
    
    return updatesPerformed;
  } catch (error) {
    console.error('ModelMeter: Error updating future model timestamps:', error);
    return 0;
  }
}

/**
 * Calculates the next timestamp after adding one period to the given timestamp
 * @param {number} timestamp - The base timestamp (milliseconds since epoch)
 * @param {Object} limitObject - Object containing period information (periodAmount, periodUnit)
 * @returns {number} The calculated future timestamp
 */
export function calculateNextTimestampAfterPeriod(timestamp, limitObject) {
  if (!limitObject || !timestamp) return null; // Guard if no limitObject or timestamp

  const date = new Date(timestamp);
  
  switch(limitObject.periodUnit) {
    case 'hour':
      date.setHours(date.getHours() + limitObject.periodAmount);
      break;
    case 'day':
      date.setDate(date.getDate() + limitObject.periodAmount);
      break;
    case 'week':
      date.setDate(date.getDate() + (limitObject.periodAmount * 7));
      break;
    case 'month':
      date.setMonth(date.getMonth() + limitObject.periodAmount);
      break;
    case 'unlimited':
    case 'none':
      return null; // For unlimited/none models, a period-based "Until" is not applicable
    default:
      // For unknown period units, log a warning and do not calculate a new time.
      console.warn(`ModelMeter: Unknown periodUnit "${limitObject.periodUnit}" for model, cannot calculate next timestamp. Original timestamp: ${timestamp}`);
      return null; // Return null if period unit is unrecognized
  }
  
  return date.getTime();
}

/**
 * Finds the appropriate limit object for a model based on name
 * @param {string} modelName - The original model name
 * @param {string} modelLowerCase - Lowercase version of the model name
 * @param {Object} modelLimits - Object containing all model limits
 * @returns {Object|null} The limit object or null if not found
 */
export function findLimitObjectForModel(modelName, modelLowerCase, modelLimits) {
  // Try to find by model name
  if (modelLimits[modelName]) {
    return modelLimits[modelName];
  } else if (modelLimits[modelLowerCase]) {
    return modelLimits[modelLowerCase];
  } else {
    // Try to find by partial match
    const matchingKey = Object.keys(modelLimits).find(key => 
      modelLowerCase.includes(key.toLowerCase()) || key.toLowerCase().includes(modelLowerCase)
    );
    if (matchingKey) {
      return modelLimits[matchingKey];
    }
  }
  
  return null;
}

/**
 * Gets model limits based on the user's current plan
 * @param {string} currentPlan - The user's plan (FREE or PLUS)
 * @returns {Object} Object containing model limits
 */
export function getModelLimits(currentPlan) {
  if (currentPlan === 'FREE') {
    return {
      'gpt-4o': { count: 15, periodAmount: 3, periodUnit: 'hour', displayText: '~15 per 3h' },
      'gpt-4o-mini': { count: Infinity, periodAmount: 0, periodUnit: 'unlimited', displayText: 'Unlimited' },
      'o3-mini': { count: 0, periodAmount: 0, periodUnit: 'none', displayText: '0' },
      'o4-mini': { count: 20, periodAmount: 5, periodUnit: 'hour', displayText: '~20 per 5h' },
      'o4-mini-high': { count: 0, periodAmount: 0, periodUnit: 'none', displayText: '0' },
      'deep-research-lite': { count: 5, periodAmount: 1, periodUnit: 'month', displayText: '5 per month' },
      'dall-e-3': { count: 3, periodAmount: 1, periodUnit: 'day', displayText: '3 per day' }
    };
  } else if (currentPlan === 'PLUS') {
    return {
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
  
  // Default to empty object if plan is not recognized
  return {};
}

/**
 * Parses a future date from a warning banner text and calculates the "since" date
 * For o3 model warnings, this calculates the "since" date as 7 days before the "until" date at 00:00
 * 
 * @param {string} warningText - The text from the warning banner
 * @param {string} modelSlug - The model identifier
 * @param {Object} limitObject - The limit object for the model
 * @returns {Object} Object with sinceTimestamp and untilTimestamp
 */
export function parseWarningTimestamps(warningText, modelSlug, limitObject) {
  const result = {
    sinceTimestamp: null,
    untilTimestamp: null
  };
  
  if (!warningText || !modelSlug) {
    console.warn('ModelMeter: Invalid input for parseWarningTimestamps');
    return result;
  }
  
  // For o3 models with weekly reset
  if (modelSlug.toLowerCase().includes('o3') && limitObject && limitObject.periodUnit === 'week') {
    // Extract the date from text like "until it resets May 19, 2025"
    const dateMatch = warningText.match(/until it resets\s+([A-Za-z]+\s+\d+,\s+\d{4})/i);
    
    if (dateMatch && dateMatch[1]) {
      try {
        // Parse the "until" date (e.g., "May 19, 2025")
        const untilDate = new Date(dateMatch[1]);
        
        if (!isNaN(untilDate.getTime())) {
          // Set time to 23:59:59 for the "until" date
          untilDate.setHours(23, 59, 59, 999);
          result.untilTimestamp = untilDate.getTime();
          
          // Calculate "since" date as 7 days before at 00:00:00
          const sinceDate = new Date(untilDate);
          sinceDate.setDate(sinceDate.getDate() - 7);
          sinceDate.setHours(0, 0, 0, 0);
          result.sinceTimestamp = sinceDate.getTime();
          
          console.log(`ModelMeter: Parsed warning for ${modelSlug}. Since: ${new Date(result.sinceTimestamp).toLocaleString()}, Until: ${new Date(result.untilTimestamp).toLocaleString()}`);
        }
      } catch (error) {
        console.error('ModelMeter: Error parsing date from warning:', error);
      }
    }
  }
  
  return result;
}

// Export the function for use in other files
// window.updateFutureModelTimestamps = updateFutureModelTimestamps; 