import { Probot } from 'probot';
import { 
  // exposeMetrics,
  useCounter
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
import { Octokit } from "@octokit/core";
import { createPullRequest } from "octokit-plugin-create-pull-request";
import parseIssueForm from '@operate-first/probot-issue-form';

const MyOctokit = Octokit.plugin(createPullRequest);
const TOKEN = "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";
const octokit = new MyOctokit({
  auth: TOKEN,
});



const generateTaskRunPayload = (name: string, context: any) => ({
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
        name: 'REPO_NAME' ,
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
        name: 'CONTEXT',
        value: JSON.stringify(context.payload),
      },
    ],
  },
});

export default (
  app: Probot,
  // {
  //   getRouter,
  // }: { getRouter?: ((path?: string | undefined) => Router) | undefined }
) => {
  console.timeLog('entered copilot-ops-bot')
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
  const wrapOperationWithMetrics = async (promise: Promise<any>, labels: any) => {
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
    console.log("onAny", action, install);
    if (!action || !install) {
      console.log("bad context", context);
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
  })
 
  app.on('issues.opened', async(context) => {

    const install = context!.payload!.installation!.id;
    
    const parseIssueInfo = async () => {
      try {
        const form = await parseIssueForm(context);
        if (!form.botInput) return;
        const issue = context.issue();
        console.log("issue.opened", issue);
        return {
          ...issue,
          userInput: typeof form.botInput === "string" ? 
            form.botInput : 
            form.botInput.join("\n"),
        };
      } catch (err) {
        console.log("An error has occurred.")
        return;
      }
    };

    const issueInfo = await parseIssueInfo();
    if (!issueInfo) return; // not an issue for us

    console.log("issueInfo", issueInfo);
    const { owner, repo, issue_number } = issueInfo;

    const head = `copilot-ops-fix-issue-${issue_number}`;
    const title = `Fixes #${issue_number} by ${owner} with copilot-ops`;
    const body = `This pull request was generated by the copilot-ops bot using this prompt:
    ${issueInfo.userInput}`;
    const changes = [{
      commit: `Fixes #${issue_number}: creating test.txt to demo pr creation`,
      files: {
        "test.txt": "Content for test file",
      },
    }];

    // Update token in case it expired
    console.log('updateSecret', getNamespace());
    console.log('updating secret...')
    await wrapOperationWithMetrics(
      updateTokenSecret(context).catch(e => {
        console.log('caught error while updating token: ', e)
        console.log('event context: ', );
      }), {
        install,
        method: 'updateSecret',
    }).then(() => {
      console.log('secret successfully updated')
    }).catch(e => {
      console.log('got error', e)
    });
    console.log("update secret done")
    
    // Trigger example taskrun
    console.log('scheduleTaskRun', getNamespace());
    await wrapOperationWithMetrics(
      useApi(APIS.CustomObjectsApi).createNamespacedCustomObject(
        'tekton.dev',
        'v1beta1',
        getNamespace(),
        'taskruns',
        generateTaskRunPayload(head, context)
      ),
      {
        install,
        method: 'scheduleTaskRun',
      }
    );


    if (false) {
      const pr = await octokit.createPullRequest({
        owner,
        repo,
        title,
        head,
        body,
        update: true,
        changes,
      });
     
      if (!pr) {
        console.log("no pr !?");
        return;
      }
   
      console.log(pr!.data.number);
    }
    
  });

  app.on('issue_comment.created', async(_context) => {
    console.log("dummy test is activating")
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
