// acoustics.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

export class WeatherAcoustics {
  constructor() {
    this.ctx = null;
    this.lowPass = null;
    this.windFilter = null;
    this.windGain = null;
    this.rainGain = null;
    this.isInitialized = false;
  }
  
  init() {
    if (this.isInitialized) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      
      // Low pass filter for wetness/fog dampening
      this.lowPass = this.ctx.createBiquadFilter();
      this.lowPass.type = 'lowpass';
      this.lowPass.frequency.value = 20000;
      
      // Synthetic wind generator
      this.initWindGenerator();
      
      // Synthetic rain generator
      this.initRainGenerator();
      
      this.isInitialized = true;
      console.log("[Client Acoustics] Audio Context and generators initialized.");

      // Setup one-time user interaction listener to resume AudioContext cleanly without console warnings
      const resumeAudio = () => {
        if (this.ctx && this.ctx.state === 'suspended') {
          this.ctx.resume().then(() => {
            console.log("[Client Acoustics] AudioContext resumed successfully by user interaction.");
          });
        }
        // Clean up listeners
        window.removeEventListener('click', resumeAudio);
        window.removeEventListener('mousedown', resumeAudio);
        window.removeEventListener('keydown', resumeAudio);
        window.removeEventListener('touchstart', resumeAudio);
      };
      window.addEventListener('click', resumeAudio);
      window.addEventListener('mousedown', resumeAudio);
      window.addEventListener('keydown', resumeAudio);
      window.addEventListener('touchstart', resumeAudio);
    } catch (e) {
      console.warn("[Client Acoustics] Audio initialization failed:", e);
    }
  }
  
  initWindGenerator() {
    const bufferSize = 2 * this.ctx.sampleRate;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }
    
    const whiteNoise = this.ctx.createBufferSource(noiseBuffer);
    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 400;
    this.windFilter.Q.value = 2.0;
    
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0.0;
    
    whiteNoise.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.lowPass);
    
    // Connect filter chain to output
    this.lowPass.connect(this.ctx.destination);
    
    whiteNoise.loop = true;
    whiteNoise.start(0);
  }
  
  initRainGenerator() {
    const bufferSize = 2 * this.ctx.sampleRate;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }
    
    const whiteNoise = this.ctx.createBufferSource(noiseBuffer);
    whiteNoise.loop = true;
    
    this.rainGain = this.ctx.createGain();
    this.rainGain.gain.value = 0.0;
    
    whiteNoise.connect(this.rainGain);
    this.rainGain.connect(this.lowPass);
    whiteNoise.start(0);
  }
  
  update(windSpeed, moisture, rainVal) {
    if (!this.isInitialized) return;
    
    const normWind = Math.min(1.0, windSpeed / 60.0);
    this.windGain.gain.setTargetAtTime(normWind * 0.35, this.ctx.currentTime, 0.1);
    this.windFilter.frequency.setTargetAtTime(150 + normWind * 600 + Math.sin(performance.now() * 0.005) * 50 * normWind, this.ctx.currentTime, 0.1);
    
    this.rainGain.gain.setTargetAtTime(rainVal * 0.2, this.ctx.currentTime, 0.1);
    
    const cutoff = moisture >= 0.55 ? 20000 - (moisture - 0.55) * 35000 : 20000;
    this.lowPass.frequency.setTargetAtTime(Math.max(600, cutoff), this.ctx.currentTime, 0.2);
  }
  
  playThunder(distance) {
    if (!this.isInitialized) return;
    
    const delaySec = Math.min(6.0, distance / 343.0);
    
    setTimeout(() => {
      if (this.ctx.state === 'suspended') return;
      
      const osc = this.ctx.createOscillator();
      const gainNode = this.ctx.createGain();
      
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(80, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(15, this.ctx.currentTime + 1.5);
      
      const vol = Math.max(0.01, 1.0 / (1.0 + distance * 0.002));
      gainNode.gain.setValueAtTime(vol * 0.8, this.ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 1.8);
      
      const thunderFilter = this.ctx.createBiquadFilter();
      thunderFilter.type = 'lowpass';
      const fCutoff = Math.max(60, 400 - (distance * 0.08));
      thunderFilter.frequency.setValueAtTime(fCutoff, this.ctx.currentTime);
      
      osc.connect(thunderFilter);
      thunderFilter.connect(gainNode);
      gainNode.connect(this.ctx.destination);
      
      osc.start();
      osc.stop(this.ctx.currentTime + 2.0);
    }, delaySec * 1000);
  }
}
