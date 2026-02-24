// Pinecone Vector Database Utility
const { Pinecone } = require('@pinecone-database/pinecone');
const crypto = require('crypto');

let pineconeClient = null;
let pineconeIndex = null;

// Initialize Pinecone client
async function initPinecone() {
  if (pineconeClient) return pineconeClient;

  try {
    pineconeClient = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY
    });

    pineconeIndex = pineconeClient.index(process.env.PINECONE_INDEX_NAME);
    
    console.log('✅ Pinecone initialized successfully');
    return pineconeClient;
  } catch (error) {
    console.error('❌ Pinecone initialization error:', error);
    throw error;
  }
}

// Generate hash for chunk to detect duplicates
function generateChunkHash(text) {
  return crypto.createHash('sha256').update(text.trim()).digest('hex');
}

// Check if chunk already exists in Pinecone
async function chunkExists(chunkHash, namespace) {
  try {
    const result = await pineconeIndex.namespace(namespace).fetch([chunkHash]);
    return result.records && Object.keys(result.records).length > 0;
  } catch (error) {
    console.error('Error checking chunk existence:', error);
    return false;
  }
}

// Store chunks in Pinecone with deduplication
async function storeChunks(chunks, metadata, namespace) {
  try {
    await initPinecone();

    const vectors = [];
    const skippedDuplicates = [];

    for (const chunk of chunks) {
      const chunkHash = generateChunkHash(chunk.text);
      
      // Check if chunk already exists
      const exists = await chunkExists(chunkHash, namespace);
      
      if (exists) {
        skippedDuplicates.push(chunkHash);
        console.log(`⏭️  Skipping duplicate chunk: ${chunkHash.substring(0, 8)}...`);
        continue;
      }

      vectors.push({
        id: chunkHash,
        values: chunk.embedding,
        metadata: {
          text: chunk.text,
          chunkIndex: chunk.index,
          fileName: metadata.fileName,
          fileHash: metadata.fileHash,
          uploadedBy: metadata.uploadedBy,
          uploadedAt: metadata.uploadedAt,
          ...metadata.additional
        }
      });
    }

    if (vectors.length > 0) {
      await pineconeIndex.namespace(namespace).upsert(vectors);
      console.log(`✅ Stored ${vectors.length} new chunks in Pinecone`);
    }

    return {
      stored: vectors.length,
      skipped: skippedDuplicates.length,
      total: chunks.length
    };
  } catch (error) {
    console.error('Error storing chunks in Pinecone:', error);
    throw error;
  }
}

// Query similar chunks from Pinecone
async function querySimilarChunks(queryEmbedding, namespace, topK = 5, filter = {}) {
  try {
    await initPinecone();

    const queryResponse = await pineconeIndex.namespace(namespace).query({
      vector: queryEmbedding,
      topK,
      includeMetadata: true,
      filter
    });

    return queryResponse.matches || [];
  } catch (error) {
    console.error('Error querying Pinecone:', error);
    throw error;
  }
}

// Delete chunks by file hash
async function deleteChunksByFileHash(fileHash, namespace) {
  try {
    await initPinecone();

    // Query all chunks with this file hash
    const dummyVector = new Array(1536).fill(0); // Dummy vector for query
    const results = await pineconeIndex.namespace(namespace).query({
      vector: dummyVector,
      topK: 10000,
      includeMetadata: true,
      filter: { fileHash }
    });

    if (results.matches && results.matches.length > 0) {
      const ids = results.matches.map(match => match.id);
      await pineconeIndex.namespace(namespace).deleteMany(ids);
      console.log(`🗑️  Deleted ${ids.length} chunks for file ${fileHash}`);
      return ids.length;
    }

    return 0;
  } catch (error) {
    console.error('Error deleting chunks:', error);
    throw error;
  }
}

// Get namespace stats
async function getNamespaceStats(namespace) {
  try {
    await initPinecone();
    const stats = await pineconeIndex.describeIndexStats();
    return stats.namespaces?.[namespace] || { vectorCount: 0 };
  } catch (error) {
    console.error('Error getting namespace stats:', error);
    return { vectorCount: 0 };
  }
}

module.exports = {
  initPinecone,
  storeChunks,
  querySimilarChunks,
  deleteChunksByFileHash,
  getNamespaceStats,
  generateChunkHash,
  chunkExists
};
