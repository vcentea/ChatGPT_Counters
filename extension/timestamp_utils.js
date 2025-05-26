// Utility functions for handling model timestamps and quota periods

(function() {
  'use strict'; // Use strict mode

  /**
   * Updates model timestamps for models without active banners but with valid future "Until" timestamps.
   * This allows timestamps to roll forward properly even without seeing a rate limit banner.
   * 
   * @returns {Promise<number>} Number of models whose timestamps were updated
   */
  async function updateFutureModelTimestamps() {
    console.log('ModelMeter: Checking for models with future reset times that need timestamp updates...');
    try {
      // Early check for extension context validity
      try {
        await chrome.runtime.sendMessage({ action: 'ping' });
      } catch (pingError) {
        console.error('ModelMeter: Extension context check failed, aborting timestamp update:', pingError);
        return 0;
      }

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
        
        // Save the updated data directly with error handling
        try {
          const saveResponse = await chrome.runtime.sendMessage({
            action: 'saveModelDataDirectly',
            modelData: modelData
          });
          
          if (saveResponse && saveResponse.status === 'success') {
            console.log('ModelMeter: Successfully saved updated model timestamps');
          } else {
            console.error('ModelMeter: Failed to save updated model timestamps');
          }
        } catch (saveError) {
          console.error('ModelMeter: Error saving updated model timestamps:', saveError);
          if (saveError.message && saveError.message.includes('Extension context invalidated')) {
            console.log('ModelMeter: Extension context invalidated during save, skipping UI refresh');
            return updatesPerformed; // Return what we accomplished before the error
          }
        }
        
        // Refresh the UI to reflect the changes (with error handling)
        try {
          chrome.runtime.sendMessage({ 
            action: 'countersDisplayShouldRefresh'
          });
        } catch (refreshError) {
          console.error('ModelMeter: Error sending UI refresh message:', refreshError);
          // Don't throw here, just log the error
        }
      } else {
        console.log('ModelMeter: No model timestamps needed updating');
      }
      
      return updatesPerformed;
    } catch (error) {
      console.error('ModelMeter: Error updating future model timestamps:', error);
      if (error.message && error.message.includes('Extension context invalidated')) {
        console.log('ModelMeter: Extension context invalidated during timestamp update');
      }
      return 0;
    }
  }

  /**
   * Calculates the next timestamp after adding one period to the given timestamp
   * @param {number} timestamp - The base timestamp (milliseconds since epoch)
   * @param {Object} limitObject - Object containing period information (periodAmount, periodUnit)
   * @returns {number} The calculated future timestamp
   */
  function calculateNextTimestampAfterPeriod(timestamp, limitObject) {
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
  function findLimitObjectForModel(modelName, modelLowerCase, modelLimits) {
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
   * Returns the model limits based on the current user plan
   * @param {string} currentPlan - The user's current plan ('FREE' or 'PLUS')
   * @returns {Object} Model limits definition object
   */
  function getModelLimits(currentPlan) {
    // Default to FREE limits
    const isPlus = currentPlan === 'PLUS';
  
    return {
      'gpt-4': {
        limit: isPlus ? 100 : 40,
        periodAmount: 1,
        periodUnit: 'day'
      },
      'gpt-4o': {
        limit: isPlus ? 100 : 25,
        periodAmount: 3,
        periodUnit: 'hour'
      },
      'gpt-3.5-turbo': {
        limit: isPlus ? 0 : 0,  // Unlimited for both plans
        periodUnit: 'unlimited'
      },
      'o4-mini': {
        limit: isPlus ? 0 : 0,  // Unlimited for now (experimental)
        periodUnit: 'unlimited'
      },
      'o4': { // Shorthand for gpt-4o
        limit: isPlus ? 100 : 25,
        periodAmount: 3,
        periodUnit: 'hour'
      },
      'g4': { // Shorthand for gpt-4
        limit: isPlus ? 100 : 40,
        periodAmount: 1,
        periodUnit: 'day'
      },
      'g4t': { // Assumed shorthand for gpt-4-turbo
        limit: isPlus ? 100 : 40,
        periodAmount: 1,
        periodUnit: 'day'
      },
      'g35t': { // Shorthand for gpt-3.5-turbo
        limit: isPlus ? 0 : 0,
        periodUnit: 'unlimited'
      }
    };
  }

  /**
   * Parses timestamps from warning text displayed in rate limit banners
   * @param {string} warningText - The warning text containing time information
   * @param {string} modelSlug - The model identifier 
   * @param {Object} limitObject - The limit object for this model
   * @returns {Object|null} Object with parsed timestamps or null if no timestamps found
   */
  function parseWarningTimestamps(warningText, modelSlug, limitObject) {
    if (!warningText) return null;
    
    console.log(`ModelMeter: Parsing warning text for model ${modelSlug}: "${warningText}"`);
    
    try {
      // Check for explicit date format first
      const dateRegex = /until (\w+ \d+), (\d+:\d+ [AP]M)/i;
      const dateParts = warningText.match(dateRegex);
      
      if (dateParts) {
        const dateStr = dateParts[1];
        const timeStr = dateParts[2];
        const fullDateStr = `${dateStr} ${timeStr}`;
        const year = new Date().getFullYear(); // Assume current year
        const parsedDate = new Date(`${fullDateStr} ${year}`);
        
        // If the parsed date is in the past, it might be for next year
        if (parsedDate < new Date()) {
          parsedDate.setFullYear(year + 1);
        }
        
        // Calculate the start time (now)
        const startTime = Date.now();
        const endTime = parsedDate.getTime();
        
        console.log(`ModelMeter: Parsed explicit date format for ${modelSlug}: Until ${parsedDate.toLocaleString()}`);
        
        return {
          since: startTime,
          until: endTime
        };
      }
      
      // Check for relative time format
      const hourRegex = /(\d+) hours? and (\d+) minutes?/i;
      const minuteRegex = /(\d+) minutes?/i;
      
      const hourMatch = warningText.match(hourRegex);
      const minuteMatch = !hourMatch && warningText.match(minuteRegex);
      
      if (hourMatch || minuteMatch) {
        const now = Date.now();
        let millisToAdd = 0;
        
        if (hourMatch) {
          const hours = parseInt(hourMatch[1]);
          const minutes = parseInt(hourMatch[2]);
          millisToAdd = (hours * 60 * 60 * 1000) + (minutes * 60 * 1000);
        } else if (minuteMatch) {
          const minutes = parseInt(minuteMatch[1]);
          millisToAdd = minutes * 60 * 1000;
        }
        
        const endTime = now + millisToAdd;
        
        console.log(`ModelMeter: Parsed relative time format for ${modelSlug}: ${millisToAdd/1000/60} minutes from now (until ${new Date(endTime).toLocaleString()})`);
        
        return {
          since: now,
          until: endTime
        };
      }
    } catch (error) {
      console.error(`ModelMeter: Error parsing warning timestamps for ${modelSlug}:`, error);
    }
    
    // If no explicit timestamps found, but we know the model's period, we can still estimate
    if (limitObject && limitObject.periodUnit !== 'unlimited' && limitObject.periodUnit !== 'none') {
      const now = Date.now();
      const estimatedUntil = calculateNextTimestampAfterPeriod(now, limitObject);
      
      console.log(`ModelMeter: No explicit timestamps found for ${modelSlug}, estimating based on period: until ${new Date(estimatedUntil).toLocaleString()}`);
      
      return {
        since: now,
        until: estimatedUntil
      };
    }
    
    console.log(`ModelMeter: Could not parse timestamps from warning text for ${modelSlug}`);
    return null;
  }

  // Create a utility object to expose functions
  const utils = {
    updateFutureModelTimestamps,
    calculateNextTimestampAfterPeriod,
    findLimitObjectForModel,
    getModelLimits,
    parseWarningTimestamps
  };

  // Expose the utilities to global scope
  if (typeof self !== 'undefined') {
    self.ModelMeterUtils = utils;
  } else if (typeof window !== 'undefined') {
    window.ModelMeterUtils = utils;
  } else if (typeof global !== 'undefined') {
    global.ModelMeterUtils = utils;
  }

  console.log('ModelMeter: Timestamp utils loaded and exposed as ModelMeterUtils');
})(); 