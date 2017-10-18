'use strict';

const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
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
  if (state === 'Closed' || state === 'Rejected') {
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
  if (issue.assigned_to) {
    for (let i = 0; i < gitlabUsers.length; i++) {
      logger.debug('User: ', gitlabUsers[i].name, ', issue user: ', issue.assigned_to.name);
      if (gitlabUsers[i].name === issue.assigned_to.name) {
        logger.debug('User ID: ', gitlabUsers[i].id);
        return gitlabUsers[i].id;
      }
    }
  }
};

const getMilestoneId = (issue) => {
  if (issue.fixed_version) {
    for (let i = 0; i < gitlabMilestones.length; i++) {
      logger.debug('Milestone: ', gitlabMilestones[i].title, ', issue Milestone: ', issue.fixed_version.name);
      if (gitlabMilestones[i].title === issue.fixed_version.name) {
        logger.debug('Milestone ID: ', gitlabMilestones[i].id);
        return gitlabMilestones[i].id;
      }
    }
  }
};

const createIssue = (id, issue) => {
  logger.debug('Issue: ', issue);
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

const uploadAttachment = (project, attachment) => {
  logger.debug(' File location: ', __dirname + '/' + attachment.filename);
  const uploadParams = new FormData();
  uploadParams.append('id', project.id);
  // uploadParams.append('file', __dirname + '/README.md');
  // uploadParams.append('')
  uploadParams.append('file', fs.createReadStream(__dirname + '/' + attachment.filename));
  uploadParams.append('PRIVATE-TOKEN', CONFIG.gitlab.key);
  uploadParams.submit({
    host: 'gitlab-tmp.edina.ac.uk',
    path: `/api/v4/projects/${project.id}/uploads`,
    headers: { 'PRIVATE-TOKEN': CONFIG.gitlab.key }
  }, function(err, res) {
    // logger.error('ERROR: ', err);
    logger.info('STATUS CODE: ', res.statusCode);
    logger.info('BODY: ', res.body);
    logger.info('BODY: ', res.data);
    let data = '';
    res.on('data', function (chunk) {
      data += chunk;
    });
    res.on('end', function () {
      logger.info('CHUNKED DATA: ', data);
      // var result = JSON.parse(data.join(''));
      // logger.info('Successfully uploaded file: ', res);
      // return result;
    });

    // logger.info('Attachment Data: ', attachmentData);
  });
  // const uploadParams = {
  //   id: project.id,
  //   file: '' + __dirname + '/README.md'
  //   // file: '' + __dirname + '/' + attachment.filename
  // };

  logger.debug('Upload PARAMS: ', uploadParams);
  gitlabConfig.headers['Content-Type'] = 'multipart/form-data';
  
  // gitlabService.defaults.headers.post['Content-Type'] = 'application/x-www-form-urlencoded';

  // gitlabService.post(`/api/v4/projects/${project.id}/uploads`,
  //                    uploadParams,
  //                    gitlabConfig)
  //   .then(response => {
  //     logger.info('Successfully uploaded attachment: ', response.data);
  //   })
  //   .catch(err => {
  //     logger.error('Error uploading attachment: ', err);
  //   });
};

const createAttachments = (project, attachments) => {
  attachments.forEach(attachment => {
    // GET request for remote image
    axios({
      method: 'get',
      url: attachment.content_url,
      responseType: 'stream',
      headers: { 'X-Redmine-API-Key': CONFIG.redmine.key }
    })
      .then(response => {
        response.data.pipe(fs.createWriteStream(attachment.filename));
        uploadAttachment(project, attachment);
      });
  });
};

const createIssues = (project) => {
  logger.info('Creating issues for project: ', project);
  // Create issues in GitLab.
  redmineIssues.forEach(issue => {
    // Get info for each issue.
    redmineService.get(`/issues/${issue.id}.json?include=journals,attachments`, redmineConfig)
      .then(res => {
        const issue = res.data.issue;
        logger.debug('Issue Content: ', issue);

        const attachments = issue.attachments;
        // if (attachments.length > 0) {
        //   // createAttachments(project, attachments);
        // }
        createIssue(project.id, issue);
      })
      .catch(e => {
        logger.error('Error getting issue data for: ', e);
      });
  });
};

const closeMilestone = (project, milestone) => {
  logger.debug('PROJECT: ', project, ', MILESTONE: ', milestone);
  const milestoneParams = {
    id: project.id,
    milestone_id: milestone.id,
    state_event: 'close'
  };

  gitlabService.put(`/api/v4/projects/${project.id}/milestones/${milestone.id}`,
    milestoneParams,
    gitlabConfig)
    .then(response => {
      logger.info(`Successfully closed milestone: ${milestone.title}`);
    })
    .catch(error => {
      logger.error('Error closing milestone: ', err)
    })
};

const createMilestone = (project, version) => {
  logger.info(`Project: ${project.name} - Milestone ${version}`);
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
      const milestone = response.data;
      logger.info('Successfully created milestone: ', milestone);
      logger.info('milestone : ', response.data);
      gitlabMilestones.push(response.data);
      if (version.status === 'closed') {
        closeMilestone(project, milestone);
      }
    })
    .catch(err => {
      logger.error('Error creating Milestone: ', err);
    });
};

const createMilestones = (project) => {
  const projectName = CONFIG.redmine.project.substr(CONFIG.redmine.project.lastIndexOf('/') + 1);
  // logger.debug('Project Milestones: ', project);
  logger.debug(`/projects/${project.name}/versions.json`);
  redmineService.get(`/projects/${projectName}/versions.json`, redmineConfig)
    .then(res => {
      const versions = res.data.versions;
      // logger.debug('Versions: ', versions);

      if (versions.length > 0) {
        versions.forEach(version => {
          createMilestone(project, version);
        });
      }
    })
    .catch(e => {
      logger.error(`Error getting milestone data for ${project.name}: `, e);
    });
};

const getProject = () => {
  const projectName = CONFIG.gitlab.project.substr(CONFIG.gitlab.project.lastIndexOf('/') + 1);
   logger.debug(`PROJECT: ${projectName}`);
  gitlabService.get(`/api/v4/projects?search=${projectName}&simple=true`,
      gitlabConfig)
    .then(response => {
      const projects = response.data;
      // logger.debug('Retreived GitLab Projects: ', projects);

      projects.forEach(proj => {
        logger.debug('Project: ', proj.path_with_namespace, ', Config Project: ', CONFIG.gitlab.project);
        if (proj.path_with_namespace === CONFIG.gitlab.project) {
          logger.debug('Creating Milestones for project: ', proj);
          createMilestones(proj);
          logger.debug('Creating Issues for project: ', proj);
          createIssues(proj);
        }
      }, this);
    })
    .catch(err => {
      logger.error(`Error getting associated Project for ${CONFIG.redmine.project}: `, err);
    });
};

const getIssues = (page) => {
  logger.debug(`URL: ${CONFIG.redmine.project}/issues.json?limit=100&status_id=*&page=${page}`);
  return redmineService.get(`/${CONFIG.redmine.project}/issues.json?limit=100&status_id=*&page=${page}`, redmineConfig);
    // .then(res => {
    //   // logger.debug('RES: ', res);
    //   const issues = res.data.issues;
    //   logger.debug('PAGED ISSUES: ', issues.length);
    //   redmineIssues = redmineIssues.concat(res.data.issues);
    // })
    // .catch(err => {
    //   logger.error('Error getting Issues: ', err);
    // });
};

const migrate = () => {
  gitlabService.get(`/api/v4/users`, gitlabConfig)
    .then(response => {
      gitlabUsers = response.data;

      // getIssues();
      // getProject();
      let page = 1;
      redmineService.get(`/${CONFIG.redmine.project}/issues.json?limit=100&status_id=*&page=${page}`, redmineConfig)
        .then(res => {
          // TODO: WE KNOW NOW HOW MANY ISSUES, REPEAT, CALL getIssues function
          // concurrently e.g. axios.all([getIssues(1), getIssues(2), getIssues(3)...]).then(axios.spread(() => {...}));
          redmineIssues = res.data.issues;
          const total = res.data.total_count
          const pages = Math.ceil(total / 100);
          logger.debug(`TOTAL PAGES: ${pages}`);
          // getIssues(pages);

          // for (let i = 1; i <= pages; i++) {
          //  getIssues(i);
          // };


          const pagedRequests =[];
          for (let i = 1; i <= pages; i++) {
           pagedRequests.push(getIssues(i));
          };

          // axios.all([getIssues(1), getIssues(2)])
          axios.all([...pagedRequests])
          .then(axios.spread((...pages) => {
            for (let i = 0; i < pages.length; i++) {
              // logger.debug('Paged issue count: ', page1.data.issues.length);
              // logger.debug('Paged issue count: ', page2.data.issues.length);
              // redmineIssues = [...page1.data.issues];
              redmineIssues = [...redmineIssues, ...pages[i].data.issues];
              logger.debug('Retreived redmine Issues: ', redmineIssues.length);
            }

            getProject();
          }))
          .catch(error => {
            logger.error(`Error getting all Paged issues for ${CONFIG.redmine.project}: `, error);
          });
          // logger.debug('Retreived redmine Issues: ', redmineIssues.length);
          // getProject();
        })
        .catch(err => {
          logger.error(`Error getting issues for ${CONFIG.redmine.project}: `, err);
        });
    })
    .catch(error => {
      logger.error('Error getting list of users from GitLab: ', error);
    });
};

const deleteIssues = (project) => {
  gitlabService.get(`/api/v4/projects/${project.id}/issues?per_page=100`, gitlabConfig)
    .then(response => {
      const issues = response.data;
      issues.forEach(issue => {
        gitlabService.delete(`/api/v4/projects/${project.id}/issues/${issue.iid}`, gitlabConfig)
          .then(response => {
            logger.info(`Successfully deleted issue: ${issue.iid}`);
          })
          .catch(err => {
            logger.error('Error deleting issue for project: ', issue, 'ERROR: ', err);
          });
      });
    })
    .catch(err => {
      logger.error('Error getting issues for project: ', project,'ERROR: ', err);
    });
};

const deleteAllIssues = () => {
  const projectName = CONFIG.gitlab.project.substr(CONFIG.gitlab.project.lastIndexOf('/') + 1);
  logger.debug(`PROJECT: ${projectName}`);
  gitlabService.get(`/api/v4/projects?search=${projectName}&simple=true`,
    gitlabConfig)
    .then(response => {
      const projects = response.data;
      // logger.debug('Retreived GitLab Projects: ', projects);

      projects.forEach(project => {
        logger.debug('Project: ', project.path_with_namespace, ', Config Project: ', CONFIG.gitlab.project);
        if (project.path_with_namespace === CONFIG.gitlab.project) {
          logger.debug('Deleting Issues for project: ', project);
          deleteIssues(project);
        }
      }, this);
    })
    .catch(err => {
      logger.error(`Error getting associated Projects for: ${CONFIG.redmine.project}: `, err);
    });
};

switch (process.argv[2]) {
  case 'migrate':
    migrate();
    break;
  case 'delete':
    deleteAllIssues();
    break;
  default:
    logger.error(`Sorry, ${process.argv[2]} is not known, use 'migrate', or 'delete'`)
}
