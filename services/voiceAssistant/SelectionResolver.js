/**
 * SelectionResolver - Resolves natural language selection commands to specific items
 * 
 * Handles multiple selection strategies:
 * - Ordinal: "first", "second", "last"
 * - Numeric: "number 3", "template 5"
 * - Exact name: "mathematics template"
 * - Fuzzy description: "the one about calculus"
 */

class SelectionResolver {
  constructor() {
    // Ordinal patterns
    this.ordinalPatterns = {
      first: /\b(?:first|1st)\b/i,
      second: /\b(?:second|2nd)\b/i,
      third: /\b(?:third|3rd)\b/i,
      fourth: /\b(?:fourth|4th)\b/i,
      fifth: /\b(?:fifth|5th)\b/i,
      last: /\blast\b/i
    };

    // Numeric patterns
    this.numericPattern = /\b(?:number|#|template|question)\s*(\d+)\b/i;
  }

  /**
   * Resolve selection from natural language
   * @param {string} transcript - User's selection command
   * @param {Array} items - Available items to select from
   * @param {string} itemType - Type of items (template, question, etc.)
   * @returns {Object} Resolution result
   */
  resolve(transcript, items, itemType = 'item') {
    if (!transcript || !Array.isArray(items) || items.length === 0) {
      return {
        success: false,
        item: null,
        matches: [],
        confidence: 0,
        needsClarification: false,
        clarificationPrompt: null,
        error: 'Invalid input or no items available'
      };
    }

    const normalizedTranscript = transcript.trim().toLowerCase();

    // Try ordinal matching first (highest priority)
    const ordinalResult = this.matchByOrdinal(normalizedTranscript, items);
    if (ordinalResult) {
      return {
        success: true,
        item: ordinalResult,
        matches: [ordinalResult],
        confidence: 0.95,
        needsClarification: false,
        clarificationPrompt: null
      };
    }

    // Try numeric index matching
    const numericResult = this.matchByIndex(normalizedTranscript, items);
    if (numericResult) {
      return {
        success: true,
        item: numericResult,
        matches: [numericResult],
        confidence: 0.9,
        needsClarification: false,
        clarificationPrompt: null
      };
    }

    // Try exact name matching
    const nameResult = this.matchByName(normalizedTranscript, items);
    if (nameResult) {
      return {
        success: true,
        item: nameResult,
        matches: [nameResult],
        confidence: 0.85,
        needsClarification: false,
        clarificationPrompt: null
      };
    }

    // Try fuzzy description matching
    const fuzzyResults = this.matchByDescription(normalizedTranscript, items);
    
    if (fuzzyResults.length === 0) {
      return {
        success: false,
        item: null,
        matches: [],
        confidence: 0,
        needsClarification: false,
        clarificationPrompt: null,
        error: `No ${itemType} matches your description`
      };
    }

    // If we have a high-confidence single match, return it
    if (fuzzyResults.length === 1 && fuzzyResults[0].confidence >= 0.6) {
      return {
        success: true,
        item: fuzzyResults[0].item,
        matches: [fuzzyResults[0].item],
        confidence: fuzzyResults[0].confidence,
        needsClarification: false,
        clarificationPrompt: null
      };
    }

    // If we have multiple matches or low confidence, request clarification
    const topMatches = fuzzyResults.slice(0, 5);
    return {
      success: false,
      item: null,
      matches: topMatches.map(m => m.item),
      confidence: topMatches[0].confidence,
      needsClarification: true,
      clarificationPrompt: this.generateClarification(topMatches, itemType)
    };
  }

  /**
   * Match by ordinal (first, second, last)
   * @param {string} transcript - Normalized transcript
   * @param {Array} items - Available items
   * @returns {Object|null} Matched item or null
   */
  matchByOrdinal(transcript, items) {
    for (const [ordinal, pattern] of Object.entries(this.ordinalPatterns)) {
      if (pattern.test(transcript)) {
        let index;
        
        switch (ordinal) {
          case 'first':
            index = 0;
            break;
          case 'second':
            index = 1;
            break;
          case 'third':
            index = 2;
            break;
          case 'fourth':
            index = 3;
            break;
          case 'fifth':
            index = 4;
            break;
          case 'last':
            index = items.length - 1;
            break;
          default:
            continue;
        }

        if (index >= 0 && index < items.length) {
          return items[index];
        }
      }
    }

    return null;
  }

  /**
   * Match by numeric index
   * @param {string} transcript - Normalized transcript
   * @param {Array} items - Available items
   * @returns {Object|null} Matched item or null
   */
  matchByIndex(transcript, items) {
    const match = transcript.match(this.numericPattern);
    
    if (match) {
      const index = parseInt(match[1], 10) - 1; // Convert to 0-based index
      
      if (index >= 0 && index < items.length) {
        return items[index];
      }
    }

    return null;
  }

  /**
   * Match by exact name
   * @param {string} transcript - Normalized transcript
   * @param {Array} items - Available items
   * @returns {Object|null} Matched item or null
   */
  matchByName(transcript, items) {
    for (const item of items) {
      const itemName = this._extractItemName(item);
      
      if (!itemName) continue;

      const normalizedItemName = itemName.toLowerCase().trim();
      
      // Check if transcript contains the full item name
      if (transcript.includes(normalizedItemName)) {
        return item;
      }

      // Check if item name contains the transcript (for shorter queries)
      if (normalizedItemName.includes(transcript)) {
        return item;
      }
    }

    return null;
  }

  /**
   * Match by fuzzy description
   * @param {string} transcript - Normalized transcript
   * @param {Array} items - Available items
   * @returns {Array} Ranked matches with confidence scores
   */
  matchByDescription(transcript, items) {
    const matches = [];

    for (const item of items) {
      const score = this._calculateSimilarity(transcript, item);
      
      if (score > 0) {
        matches.push({
          item,
          confidence: score
        });
      }
    }

    // Sort by confidence (highest first)
    matches.sort((a, b) => b.confidence - a.confidence);

    return matches;
  }

  /**
   * Calculate similarity score between transcript and item
   * @private
   * @param {string} transcript - Normalized transcript
   * @param {Object} item - Item to compare
   * @returns {number} Similarity score (0-1)
   */
  _calculateSimilarity(transcript, item) {
    const itemName = this._extractItemName(item);
    const itemDescription = this._extractItemDescription(item);
    
    if (!itemName && !itemDescription) return 0;

    let maxScore = 0;

    // Score based on name
    if (itemName) {
      const nameScore = this._tokenBasedSimilarity(transcript, itemName.toLowerCase());
      maxScore = Math.max(maxScore, nameScore * 1.2); // Weight name higher
    }

    // Score based on description
    if (itemDescription) {
      const descScore = this._tokenBasedSimilarity(transcript, itemDescription.toLowerCase());
      maxScore = Math.max(maxScore, descScore);
    }

    return Math.min(maxScore, 1.0); // Cap at 1.0
  }

  /**
   * Token-based similarity scoring
   * @private
   * @param {string} query - Query string
   * @param {string} target - Target string
   * @returns {number} Similarity score (0-1)
   */
  _tokenBasedSimilarity(query, target) {
    // Remove common words
    const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'about'];
    
    const queryTokens = query.split(/\s+/).filter(t => t.length > 2 && !stopWords.includes(t));
    const targetTokens = target.split(/\s+/).filter(t => t.length > 2 && !stopWords.includes(t));

    if (queryTokens.length === 0) return 0;

    let matchCount = 0;
    
    for (const queryToken of queryTokens) {
      for (const targetToken of targetTokens) {
        // Exact match
        if (queryToken === targetToken) {
          matchCount += 1.0;
          break;
        }
        // Partial match (one contains the other)
        else if (targetToken.includes(queryToken) || queryToken.includes(targetToken)) {
          matchCount += 0.7;
          break;
        }
        // Levenshtein-like similarity for typos
        else if (this._levenshteinSimilarity(queryToken, targetToken) > 0.7) {
          matchCount += 0.5;
          break;
        }
      }
    }

    return matchCount / queryTokens.length;
  }

  /**
   * Calculate Levenshtein similarity
   * @private
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} Similarity score (0-1)
   */
  _levenshteinSimilarity(str1, str2) {
    const distance = this._levenshteinDistance(str1, str2);
    const maxLength = Math.max(str1.length, str2.length);
    
    if (maxLength === 0) return 1.0;
    
    return 1.0 - (distance / maxLength);
  }

  /**
   * Calculate Levenshtein distance
   * @private
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} Edit distance
   */
  _levenshteinDistance(str1, str2) {
    const matrix = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * Extract item name
   * @private
   * @param {Object} item - Item object
   * @returns {string|null} Item name or null
   */
  _extractItemName(item) {
    if (typeof item === 'string') return item;
    
    return item.template_name || 
           item.name || 
           item.question_text || 
           item.text ||
           item.title ||
           null;
  }

  /**
   * Extract item description
   * @private
   * @param {Object} item - Item object
   * @returns {string|null} Item description or null
   */
  _extractItemDescription(item) {
    if (typeof item === 'string') return item;
    
    return item.description || 
           item.desc ||
           item.question_text ||
           item.text ||
           null;
  }

  /**
   * Generate clarification prompt for ambiguous matches
   * @param {Array} matches - Multiple matching items with confidence
   * @param {string} itemType - Type of items
   * @returns {string} Clarification prompt
   */
  generateClarification(matches, itemType = 'item') {
    if (!matches || matches.length === 0) {
      return `I couldn't find any ${itemType}s matching your description.`;
    }

    if (matches.length === 1) {
      const itemName = this._extractItemName(matches[0].item);
      return `Did you mean ${itemName}?`;
    }

    const itemNames = matches.map(m => this._extractItemName(m.item)).filter(Boolean);
    
    if (itemNames.length === 2) {
      return `I found multiple matches. Did you mean ${itemNames[0]} or ${itemNames[1]}?`;
    }

    const firstTwo = itemNames.slice(0, 2);
    return `I found multiple matches: ${firstTwo.join(', ')}, and ${itemNames.length - 2} more. Which one did you mean?`;
  }
}

module.exports = SelectionResolver;
