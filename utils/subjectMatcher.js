/**
 * SubjectMatcher - Fuzzy matching utility for subject names
 * 
 * Handles variations in subject names like:
 * - Case differences: "Physics" vs "physics"
 * - Extra spaces: "Physics  " vs "Physics"
 * - Punctuation: "Physics-I" vs "Physics I"
 * - Common abbreviations: "Maths" vs "Mathematics"
 * - Typos and minor variations
 */

class SubjectMatcher {
  constructor() {
    // Common subject name variations and abbreviations
    this.subjectAliases = {
      'mathematics': ['maths', 'math', 'mathematics'],
      'physics': ['physics', 'phy'],
      'chemistry': ['chemistry', 'chem', 'che'],
      'biology': ['biology', 'bio'],
      'computer science': ['computer science', 'cs', 'comp sci', 'computer', 'computers'],
      'information technology': ['information technology', 'it', 'info tech'],
      'english': ['english', 'eng'],
      'hindi': ['hindi', 'hin'],
      'marathi': ['marathi', 'mar'],
      'history': ['history', 'hist'],
      'geography': ['geography', 'geo'],
      'economics': ['economics', 'eco', 'econ'],
      'political science': ['political science', 'pol sci', 'politics'],
      'sociology': ['sociology', 'socio'],
      'psychology': ['psychology', 'psych'],
      'accountancy': ['accountancy', 'accounts', 'accounting'],
      'business studies': ['business studies', 'business', 'bs'],
      'physical education': ['physical education', 'pe', 'phy ed']
    };
  }

  /**
   * Normalize a subject name for comparison
   * @param {string} subject - Subject name to normalize
   * @returns {string} Normalized subject name
   */
  normalize(subject) {
    if (!subject) return '';
    
    return subject
      .toLowerCase()
      .trim()
      // Remove extra spaces
      .replace(/\s+/g, ' ')
      // Remove punctuation except spaces
      .replace(/[^\w\s]/g, '')
      // Remove common suffixes
      .replace(/\s+(i|ii|iii|iv|v|1|2|3|4|5)$/i, '')
      .trim();
  }

  /**
   * Calculate similarity score between two strings (0-1)
   * Uses Levenshtein distance
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} Similarity score (0-1, where 1 is exact match)
   */
  calculateSimilarity(str1, str2) {
    const s1 = this.normalize(str1);
    const s2 = this.normalize(str2);
    
    if (s1 === s2) return 1.0;
    if (s1.length === 0 || s2.length === 0) return 0.0;
    
    // Levenshtein distance
    const matrix = [];
    
    for (let i = 0; i <= s2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= s1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= s2.length; i++) {
      for (let j = 1; j <= s1.length; j++) {
        if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
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
    
    const maxLength = Math.max(s1.length, s2.length);
    const distance = matrix[s2.length][s1.length];
    
    return 1 - (distance / maxLength);
  }

  /**
   * Check if two subject names match (with fuzzy matching)
   * @param {string} subject1 - First subject name
   * @param {string} subject2 - Second subject name
   * @param {number} threshold - Similarity threshold (0-1, default 0.8)
   * @returns {boolean} True if subjects match
   */
  matches(subject1, subject2, threshold = 0.8) {
    const normalized1 = this.normalize(subject1);
    const normalized2 = this.normalize(subject2);
    
    // Exact match after normalization
    if (normalized1 === normalized2) return true;
    
    // Check aliases
    if (this.areAliases(normalized1, normalized2)) return true;
    
    // Fuzzy match using similarity score
    const similarity = this.calculateSimilarity(subject1, subject2);
    return similarity >= threshold;
  }

  /**
   * Check if two subjects are known aliases of each other
   * @param {string} subject1 - First subject (normalized)
   * @param {string} subject2 - Second subject (normalized)
   * @returns {boolean} True if they are aliases
   */
  areAliases(subject1, subject2) {
    for (const [canonical, aliases] of Object.entries(this.subjectAliases)) {
      if (aliases.includes(subject1) && aliases.includes(subject2)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Find matching subjects from a list
   * @param {string} targetSubject - Subject to match
   * @param {Array} subjectList - List of subject names to search
   * @param {number} threshold - Similarity threshold (default 0.8)
   * @returns {Array} Array of matching subjects with scores
   */
  findMatches(targetSubject, subjectList, threshold = 0.8) {
    const matches = [];
    
    for (const subject of subjectList) {
      const similarity = this.calculateSimilarity(targetSubject, subject);
      
      if (similarity >= threshold) {
        matches.push({
          subject: subject,
          similarity: similarity,
          isExact: similarity === 1.0
        });
      }
    }
    
    // Sort by similarity (highest first)
    matches.sort((a, b) => b.similarity - a.similarity);
    
    return matches;
  }

  /**
   * Generate SQL WHERE clause for fuzzy subject matching
   * @param {string} targetSubject - Subject to match
   * @param {string} columnName - Column name (default 'subject_name')
   * @returns {Object} Object with sql and params
   */
  generateSQLMatch(targetSubject, columnName = 'subject_name') {
    const normalized = this.normalize(targetSubject);
    
    // Find all possible aliases
    const aliases = [normalized];
    for (const [canonical, aliasList] of Object.entries(this.subjectAliases)) {
      if (aliasList.includes(normalized)) {
        aliases.push(...aliasList.filter(a => a !== normalized));
        break;
      }
    }
    
    // Build SQL with multiple conditions
    const conditions = [];
    const params = [];
    
    // Exact match (case-insensitive)
    conditions.push(`LOWER(TRIM(${columnName})) = ?`);
    params.push(normalized);
    
    // Alias matches
    for (const alias of aliases.slice(1)) {
      conditions.push(`LOWER(TRIM(${columnName})) = ?`);
      params.push(alias);
    }
    
    // LIKE match for partial matches (e.g., "Physics I" matches "Physics")
    conditions.push(`LOWER(TRIM(${columnName})) LIKE ?`);
    params.push(`${normalized}%`);
    
    const sql = `(${conditions.join(' OR ')})`;
    
    return { sql, params };
  }
}

// Singleton instance
let matcherInstance = null;

/**
 * Get or create the singleton SubjectMatcher instance
 * @returns {SubjectMatcher} Singleton instance
 */
function getSubjectMatcher() {
  if (!matcherInstance) {
    matcherInstance = new SubjectMatcher();
  }
  return matcherInstance;
}

module.exports = {
  SubjectMatcher,
  getSubjectMatcher
};
