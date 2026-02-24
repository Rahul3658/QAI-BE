/**
 * PerformanceTracker - Utility class for tracking and logging performance metrics
 * during question variation generation
 */
class PerformanceTracker {
  constructor(batchNumber, batchSize) {
    this.batchNumber = batchNumber;
    this.batchSize = batchSize;
    this.startTime = performance.now();
    this.metrics = {};
  }
  
  markAPIStart() {
    this.apiStart = performance.now();
  }
  
  markAPIEnd() {
    if (this.apiStart) {
      this.metrics.apiTime = performance.now() - this.apiStart;
    }
  }
  
  markParseStart() {
    this.parseStart = performance.now();
  }
  
  markParseEnd() {
    if (this.parseStart) {
      this.metrics.parseTime = performance.now() - this.parseStart;
    }
  }
  
  markDBStart() {
    this.dbStart = performance.now();
  }
  
  markDBEnd() {
    if (this.dbStart) {
      this.metrics.dbTime = performance.now() - this.dbStart;
    }
  }
  
  logSummary(variationsGenerated) {
    const totalTime = performance.now() - this.startTime;
    const throughput = variationsGenerated > 0 
      ? (variationsGenerated / (totalTime / 1000)).toFixed(2) 
      : '0.00';
    
    console.log(`📊 Batch ${this.batchNumber} Performance:`);
    console.log(`   API: ${this.metrics.apiTime?.toFixed(0) || 'N/A'}ms`);
    console.log(`   Parse: ${this.metrics.parseTime?.toFixed(0) || 'N/A'}ms`);
    console.log(`   DB: ${this.metrics.dbTime?.toFixed(0) || 'N/A'}ms`);
    console.log(`   Total: ${totalTime.toFixed(0)}ms`);
    console.log(`   Throughput: ${throughput} variations/sec`);
  }
  
  getMetrics() {
    const totalTime = performance.now() - this.startTime;
    return {
      batchNumber: this.batchNumber,
      batchSize: this.batchSize,
      apiTime: this.metrics.apiTime,
      parseTime: this.metrics.parseTime,
      dbTime: this.metrics.dbTime,
      totalTime,
      metrics: this.metrics
    };
  }
}

module.exports = PerformanceTracker;
