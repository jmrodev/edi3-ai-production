export interface MetricsTracker {
  requestsTotal: number;
  tokensInEstimated: number;
  tokensOutEstimated: number;
  costEstimateUsd: number;
  engineUsage: {
    ollama: number;
    gemini: number;
    fallback: number;
  };
}

export class MetricsService {
  private startTime = Date.now();
  private metrics: MetricsTracker = {
    requestsTotal: 0,
    tokensInEstimated: 0,
    tokensOutEstimated: 0,
    costEstimateUsd: 0.0,
    engineUsage: {
      ollama: 0,
      gemini: 0,
      fallback: 0
    }
  };

  public recordRequest(endpoint: string) {
    this.metrics.requestsTotal += 1;
  }

  public recordAIUsage(
    engine: 'ollama-qwen2.5:3b' | 'gemini-2.5-flash' | 'gemini-3.5-flash-lite' | 'system-contingency',
    inputText: string,
    outputText: string
  ) {
    // Estimación KISS de tokens (aprox 4 caracteres por token)
    const tokensIn = Math.ceil(inputText.length / 4);
    const tokensOut = Math.ceil(outputText.length / 4);

    this.metrics.tokensInEstimated += tokensIn;
    this.metrics.tokensOutEstimated += tokensOut;

    if (engine.startsWith('ollama')) {
      this.metrics.engineUsage.ollama += 1;
      // Ollama local = $0.00 USD
    } else if (engine.startsWith('gemini')) {
      this.metrics.engineUsage.gemini += 1;
      // Gemini 2.5 Flash aprox: $0.075 / 1M in, $0.30 / 1M out
      const cost = (tokensIn * 0.000000075) + (tokensOut * 0.00000030);
      this.metrics.costEstimateUsd += cost;
    } else {
      this.metrics.engineUsage.fallback += 1;
      // Fallback determinista = $0.00 USD
    }
  }

  public getMetrics() {
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      requestsTotal: this.metrics.requestsTotal,
      tokensInEstimated: this.metrics.tokensInEstimated,
      tokensOutEstimated: this.metrics.tokensOutEstimated,
      costEstimateUsd: Number(this.metrics.costEstimateUsd.toFixed(6)),
      engineUsage: {
        ollama: this.metrics.engineUsage.ollama,
        gemini: this.metrics.engineUsage.gemini,
        fallback: this.metrics.engineUsage.fallback
      }
    };
  }

  public maskPII(text: string): string {
    // Ofusca teléfonos E.164: +5492494112233 -> +549*****2233
    return text.replace(/(\+\d{3,4})\d{4,8}(\d{4})/g, '$1*****$2');
  }
}

export const metricsService = new MetricsService();
