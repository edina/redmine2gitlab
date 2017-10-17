'use strict';

const axios = require('axios');
const log4js = require('log4js');
const logger = log4js.getLogger();
logger.level = 'trace';

const CONFIG = {
  redmine: {
    base: 'HOSTNAME',
    project: 'PROJECT',
    key: 'KEY'
  },
  gitlab: {
    base: 'HOSTNAME',
    project: 'PROJECT',
    key: 'KEY'
  }
};

const redmineConfig = {
  headers: {
    'X-Redmine-API-Key': CONFIG.redmine.key
  }
};

const gitlabConfig = {
  headers: { 'PRIVATE-TOKEN': CONFIG.gitlab.key }
};

let redmineIssues = [];
let gitlabUsers = [];
let gitlabMilestones = [];
// let gitlabAttachments = [];

const scheduleRequests = (axiosInstance, intervalMs) => {
  let lastInvocationTime = undefined;

  const scheduler = (config) => {
    const now = Date.now();
    if (lastInvocationTime) {
      lastInvocationTime += intervalMs;
      const waitPeriodForThisRequest = lastInvocationTime - now;

      if (waitPeriodForThisRequest > 0) {
        return new Promise((resolve) => {
          setTimeout(() => resolve(config), waitPeriodForThisRequest);
        });
      }
    }

    lastInvocationTime = now;
    return config;
  }

  axiosInstance.interceptors.request.use(scheduler);
};

const redmineService = axios.create({ baseURL: CONFIG.redmine.base });
const gitlabService = axios.create({ baseURL: CONFIG.gitlab.base });
scheduleRequests(gitlabService, 1000);

const closeIssue = (state, id, iid) => {
  // Set state of closed issues.
  if (state === 'Closed') {
    const closeIssueParams = {
      state_event: 'close'
    };

    gitlabService.put(`/api/v4/projects/${id}/issues/${iid}`, closeIssueParams, gitlabConfig)
      .then(response => {
        logger.info(`Successfully closed issue: ${iid}`);
      })
      .catch(err => {
        logger.error(`Error closing issue ${iid}: `, err);
      }
    );
  }
};

const addNote = (id, iid, journal) => {
  const updateIssueParams = {
    body: journal.notes,
    created_at: journal.created_on
  };

  gitlabService.post(`/api/v4/projects/${id}/issues/${iid}/notes`,
                     updateIssueParams, 
                     gitlabConfig)
    .then(response => {
      logger.info(`Successfully added note to issue: ${iid}`);
    })
    .catch(err => {
      logger.error(`Error adding note to issue ${iid}: `, err);
    });

};

const getUserId = (issue) => {
  let userId = undefined;
  if (issue.assigned_to) {
    gitlabUsers.forEach(user => {
      logger.debug('User: ', user, ', issue user: ', issue.assigned_to.name);
      if (user.name === issue.assigned_to.name) {
        logger.debug('User ID: ', user.id);
        userId = user.id;
      }
    });
  }

  return userId;
};

const getMilestoneId = (issue) => {
  let milestoneId = undefined;
  logger.debug('Get Milestone ID: ', issue);
  if (issue.fixed_version) {
    gitlabMilestones.forEach(milestone => {
      logger.debug('Milestone: ', milestone.title, ', issue Milestone: ', issue.fixed_version.name);
      if (milestone.title === issue.fixed_version.name) {
        logger.debug('Milestone ID: ', milestone.id);
        milestoneId = milestone.id;
      }
    });
  }

  return milestoneId;
};

// const addAttachment = (id, attachment) => {
//   const attachmentParams = {
//     file: ''
//   };

//   gitlabService.post(`/api/v4/projects/${id}/uploads`, 
//                      attachmentParams, 
//                      gitlabConfig)
//     .then(response => {
//     })
//     .catch(err => {
//       logger.error('Error adding attachment: ', err);
//     })
// };

// const attachments = () => {

// };

// const createAttachments = (project) => {
//   redmineService.get(`/projects/${project.name}/versions.json`, redmineConfig)
//     .then(res => {
//       const versions = res.data.versions;
//       logger.debug('Versions: ', versions);

//       if (versions.length > 0) {
//         versions.forEach(version => {
//           createMilestone(project.id, version);
//         });
//       } else {
//         createIssue(project.id, issueData, users);
//       }
//     })
//     .catch(e => {
//       logger.error(`Error getting milestone data for ${project.name}: `, e);
//     });
// };

const createIssue = (id, issue) => {
  const issueParams = {
    id: id,
    title: issue.subject,
    description: issue.description,
    created_at: issue.created_on,
  };

  const userId = getUserId(issue);
  logger.debug(`Returned User ID:, ${userId}`);
  if (userId) {
    issueParams['assignee_ids'] = [userId];
    logger.debug(`Added User ID:, ${userId}`);
  }

  const milestoneId = getMilestoneId(issue);
  logger.debug(`Returned Milestone ID:, ${milestoneId}`);
  if (milestoneId) {
    issueParams['milestone_id'] = milestoneId;
    logger.debug(`Added Milestone ID:, ${milestoneId}`);
  }

  logger.debug('Issue Params: ', issueParams);

  gitlabService.post(`/api/v4/projects/${id}/issues`, issueParams, gitlabConfig)
    .then(response => {
      const createIssueResponse = response.data;
      const journals = issue.journals;
      const attachments = issue.attachments;

      journals.forEach(journal => {
        if (journal.notes && journal.notes.length > 0) {
          // Add a note to the issue.
          addNote(id, createIssueResponse.iid, journal);
        }
      });

      // attachments.forEach(attachment => {
      //   // Attach a file to the issue.
      //   addAttachment(id, attachment);
      // });

      // Set issue state to closed if that is it's state.
      closeIssue(issue.status.name, id, createIssueResponse.iid);
    })
    .catch(err => {
      logger.error(`Error creating issue ${issue.subject}: `,
        err,
        issueParams);
    });
};

const createIssues = (project) => {
  // Create issues in GitLab.
  redmineIssues.forEach(issue => {
    // Get info for each issue.
    redmineService.get(`/issues/${issue.id}.json?include=journals,attachments`, redmineConfig)
      .then(res => {
        const issue = res.data.issue;
        logger.debug('Issue Content: ', issue);

        createIssue(project.id, issue);
      })
      .catch(e => {
        logger.error('Error getting issue data for: ', e);
      });
  });
};

const createMilestone = (project, version) => {
  const milestoneParams = {
    id: project.id,
    title: version.name,
    description: version.description,
    due_date: version.due_date
  };
  gitlabService.post(`/api/v4/projects/${project.id}/milestones`, 
                    milestoneParams, 
                    gitlabConfig)
    .then(response => {
      logger.info('Successfully created milestone: ', response.data);
      gitlabMilestones.push(response.data);

      createIssues(project);
    })
    .catch(err => {
      logger.error('Error creating Milestone: ', err);
    });
};

const createMilestones = (project) => {
  // logger.debug('Project Milestones: ', project);
  // logger.debug(`/projects/${project.name}/versions.json`);
  redmineService.get(`/projects/${project.name}/versions.json`, redmineConfig)
    .then(res => {
      const versions = res.data.versions;
      // logger.debug('Versions: ', versions);

      if (versions.length > 0) {
        versions.forEach(version => {
          createMilestone(project, version);
        });
      } else {
        createIssues();
      }
    })
    .catch(e => {
      logger.error(`Error getting milestone data for ${project.name}: `, e);
    });
};

const getProject = () => {
  const projectName = CONFIG.gitlab.project.substr(CONFIG.gitlab.project.lastIndexOf('/') + 1);
  //  logger.debug(`PROJECT: ${project}`);
  gitlabService.get(`/api/v4/projects?search=${projectName}&simple=true`,
      gitlabConfig)
    .then(response => {
      const projects = response.data;

      projects.forEach(proj => {
        if (proj.path_with_namespace === CONFIG.gitlab.project) {
          createMilestones(proj);
        }
      }, this);
    })
    .catch(err => {
      logger.error(`Error getting associated Project for ${CONFIG.redmine.project}: `, err);
    });
};

const migrate = () => {
  gitlabService.get(`/api/v4/users`, gitlabConfig)
    .then(response => {
      gitlabUsers = response.data;
      redmineService.get(`/${CONFIG.redmine.project}/issues.json?limit=100&status_id=*`, redmineConfig)
        .then(res => {
          redmineIssues = res.data.issues;
          getProject();
        })
        .catch(err => {
          logger.error(`Error getting issues for ${CONFIG.redmine.project}: `, err);
        });
    })
    .catch(error => {
      logger.error('Error getting list of users from GitLab: ', error);
    });
};

migrate();
