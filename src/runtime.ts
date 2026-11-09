import { protectScheduledInvocation } from './scheduled-contract';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleRunScheduled } from './index';
import worker from './index';
import { withStatusSnapshot } from './status-snapshot';

export default withStatusSnapshot(worker, {
  name: 'TrendPulse',
  store: env => env.TP_DATA,
  maxAgeMs: 8 * 60 * 60 * 1000,
});

/** Only a Service Binding explicitly naming ScheduledIngress reaches this handler.
 * The public default entrypoint has no execution route. */
export class ScheduledIngress extends WorkerEntrypoint<Parameters<typeof handleRunScheduled>[1]> {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/internal/run-scheduled') {
      return new Response('Not Found', { status: 404 });
    }
    return protectScheduledInvocation(request, this.env, 'trendpulse', 'trend-digests', () => handleRunScheduled(request, this.env));
  }
}
