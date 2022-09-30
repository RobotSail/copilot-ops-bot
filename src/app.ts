import { Probot } from 'probot';
import {
  // exposeMetrics,
  useCounter,
} from '@operate-first/probot-metrics';
import {
  APIS,
  createTokenSecret,
  deleteTokenSecret,
  getNamespace,
  getTokenSecretName,
  updateTokenSecret,
  useApi,
} from '@operate-first/probot-kubernetes';
import parseIssueForm from '@operate-first/probot-issue-form';
import { REROLL_COMMAND } from './constants';

const generateTaskRunPayload = (
  name: string,
  context: any,
  userInput: string
) => ({
  apiVersion: 'tekton.dev/v1beta1',
  kind: 'TaskRun',
  metadata: {
    // "copilot-ops-bot" to match the prefix in manifests/base/tasks/kustomization.yaml namePrefix
    // (not necessary for functionality, just for consistency)
    generateName: `copilot-ops-bot-${name}-`,
  },
  spec: {
    taskRef: {
      // "copilot-ops-bot" to match the prefix in manifests/base/tasks/kustomization.yaml namePrefix
      // necessary for functionality
      // name: 'copilot-ops-bot-' + name,
      name: 'copilot-ops-task',
    },
    params: [
      {
        name: 'REPO_NAME',
        value: context.issue().repo,
      },
      {
        name: 'ISSUE_NUMBER',
        value: context.issue().issue_number,
      },
      {
        name: 'ISSUE_OWNER',
        value: context.issue().owner,
      },
      {
        name: 'SECRET_NAME',
        value: getTokenSecretName(context),
      },
      {
        name: 'USER_INPUT',
        value: userInput,
      },
    ],
  },
});

export default (
  app: Probot
  // {
  //   getRouter,
  // }: { getRouter?: ((path?: string | undefined) => Router) | undefined }
) => {
  console.timeLog('entered copilot-ops-bot');
  // Expose additional routes for /healthz and /metrics
  // if (!getRouter) {
  //   console.log('router is not defined')
  //   app.log.error('Missing router.');
  //   return;
  // }
  // const router = getRouter();
  // router.get('/healthz', (_, response) => response.status(200).send('OK'));
  // exposeMetrics(router, '/metrics');

  // Register tracked metrics
  const numberOfInstallTotal = useCounter({
    name: 'num_of_install_total',
    help: 'Total number of installs received',
    labelNames: [],
  });
  const numberOfUninstallTotal = useCounter({
    name: 'num_of_uninstall_total',
    help: 'Total number of uninstalls received',
    labelNames: [],
  });
  const numberOfActionsTotal = useCounter({
    name: 'num_of_actions_total',
    help: 'Total number of actions received',
    labelNames: ['install', 'action'],
  });
  const operationsTriggered = useCounter({
    name: 'operations_triggered',
    help: 'Metrics for action triggered by the operator with respect to the kubernetes operations.',
    labelNames: ['install', 'operation', 'status', 'method'],
  });

  // Simple callback wrapper - executes and async operation and based on the result it inc() operationsTriggered counted
  const wrapOperationWithMetrics = async (
    promise: Promise<any>,
    labels: any
  ) => {
    labels.operation = 'k8s';
    try {
      await promise;
      labels.status = 'Succeeded';
    } catch (err) {
      labels.status = 'Failed';
      console.error('Error', err);
      throw err;
    } finally {
      operationsTriggered.labels(labels).inc();
    }
  };

  app.onAny((context) => {
    const action = (context?.payload as any)?.action;
    const install = (context?.payload as any)?.installation?.id;
    console.log('onAny', action, install);
    if (!action || !install) {
      console.log('bad context', context);
      return;
    }
    const labels = { install, action };
    numberOfActionsTotal.labels(labels).inc();
  });

  // secret is created when this event runs
  app.on('installation.created', async (context) => {
    numberOfInstallTotal.labels({}).inc();

    // Create secret holding the access token
    await wrapOperationWithMetrics(createTokenSecret(context), {
      install: context.payload.installation.id,
      method: 'createSecret',
    });
  });

  app.onError((e) => {
    console.log('error:', e.message);
    console.log(`error on event: ${e.event.name}, id: ${e.event.id}`);
  });

  app.on('issues.opened', async (context) => {
    console.log('received issue');
    const install = context!.payload!.installation!.id;

    const parseIssueInfo = async () => {
      try {
        const form = await parseIssueForm(context);
        if (!form.botInput) return;
        const issue = context.issue();
        console.log('issue.opened', issue);
        return {
          ...issue,
          userInput:
            typeof form.botInput === 'string'
              ? form.botInput
              : form.botInput.join('\n'),
        };
      } catch (err) {
        console.log('An error has occurred.');
        return;
      }
    };

    const issueInfo = await parseIssueInfo();
    if (!issueInfo) return; // not an issue for us

    const { issue_number } = issueInfo;

    const head = `copilot-ops-fix-issue-${issue_number}`;

    // Update token in case it expired
    console.log('updateSecret', getNamespace());
    console.log('updating secret...');
    await wrapOperationWithMetrics(
      updateTokenSecret(context).catch((e) => {
        console.log('caught error while updating token: ', e);
      }),
      {
        install,
        method: 'updateSecret',
      }
    )
      .then(() => {
        console.log('secret successfully updated');
      })
      .catch((e) => {
        console.log('got error', e);
      });
    console.log('update secret done');

    // Trigger example taskrun
    console.log('scheduleTaskRun', getNamespace());
    await wrapOperationWithMetrics(
      useApi(APIS.CustomObjectsApi).createNamespacedCustomObject(
        'tekton.dev',
        'v1beta1',
        getNamespace(),
        'taskruns',
        generateTaskRunPayload(head, context, issueInfo.userInput)
      ),
      {
        install,
        method: 'scheduleTaskRun',
      }
    );
  });

  app.on('issue_comment.created', async (context) => {
    console.log('type of context:', typeof context);
    const { isBot, payload } = context;
    const { comment, sender } = payload;
    // only the author should be able to make comments
    if (isBot || sender.id !== payload.issue.user.id) {
      console.log('skipping bot comment');
      return;
    }
    // re-create the PR
    if (comment.body.trim() === REROLL_COMMAND) {
      // TODO: move the following body into its own function
      const install = context!.payload!.installation!.id;
      console.log('creating a new PR');

      const parseIssueInfo = async () => {
        try {
          const form = await parseIssueForm(context);
          if (!form.botInput) return;
          const issue = context.issue();
          console.log('issue.opened', issue);
          return {
            ...issue,
            userInput:
              typeof form.botInput === 'string'
                ? form.botInput
                : form.botInput.join('\n'),
          };
        } catch (err) {
          console.log('An error has occurred.');
          return;
        }
      };

      const issueInfo = await parseIssueInfo();
      if (!issueInfo) return; // not an issue for us

      const { issue_number } = issueInfo;

      const head = `copilot-ops-fix-issue-${issue_number}`;

      // Update token in case it expired
      console.log('updateSecret', getNamespace());
      console.log('updating secret...');
      await wrapOperationWithMetrics(
        updateTokenSecret(context).catch((e) => {
          console.log('caught error while updating token: ', e);
        }),
        {
          install,
          method: 'updateSecret',
        }
      )
        .then(() => {
          console.log('secret successfully updated');
        })
        .catch((e) => {
          console.log('got error', e);
        });
      console.log('update secret done');

      // Trigger example taskrun
      console.log('scheduleTaskRun', getNamespace());
      await wrapOperationWithMetrics(
        useApi(APIS.CustomObjectsApi).createNamespacedCustomObject(
          'tekton.dev',
          'v1beta1',
          getNamespace(),
          'taskruns',
          generateTaskRunPayload(head, context, issueInfo.userInput)
        ),
        {
          install,
          method: 'scheduleTaskRun',
        }
      );
    }
    console.log('done');
  });

  app.on('installation.deleted', async (context: any) => {
    numberOfUninstallTotal.labels({}).inc();

    // Delete secret containing the token
    await wrapOperationWithMetrics(deleteTokenSecret(context), {
      install: context.payload.installation!.id,
      method: 'deleteSecret',
    });
  });
};
