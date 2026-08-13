import vercelConfiguration from '../../../vercel.json';
import { BACKRANQ_QUEUE_TOPIC } from '@/lib/queues/backranq';
import {
    evaluateDeploymentReadiness,
    readVercelReadinessConfiguration,
    type DeploymentReadiness,
    type DeploymentReadinessCheck,
    type ReadinessEnv,
    type ReadinessProfile,
} from './deploymentReadinessCore';

export type { DeploymentReadiness, DeploymentReadinessCheck };

export function getDeploymentReadiness(
    env: ReadinessEnv = process.env,
    profile: ReadinessProfile = 'production'
): DeploymentReadiness {
    return evaluateDeploymentReadiness({
        env,
        profile,
        expectedQueueTopic: BACKRANQ_QUEUE_TOPIC,
        vercel: readVercelReadinessConfiguration(vercelConfiguration),
    });
}
