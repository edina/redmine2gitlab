'use strict';

const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const concat = require('concat-stream');
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
let gitlabAttachments = [];

/**
 * Throttle XMLHTTRequests on an axios instance by the
 * supplied interval.
 * I found requests where failing, this seemed to fix the problem
 * but more likely just masks the real problem.
 */
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

/**
 * Due to ERCONNRESET errors I've had to throttle many requests, this
 * sets up axios instances to be throttled.
 */
const redmineService = axios.create({ baseURL: CONFIG.redmine.base });
const gitlabService = axios.create({ baseURL: CONFIG.gitlab.base });
scheduleRequests(redmineService, 1000);
scheduleRequests(gitlabService, 1000);

/**
 * Close a specific GitLab Issue, if it's Redmine counterpart is 
 * 'closed' or 'Rejected'.
 * 
 * @param state The state of the redmine issue.
 * @param id The id of the GitLab Project, the issue belongs to.
 * @param iid The id of the GitLab Issue to close.
 */
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

/**
 * Add a note to a specific GitLab Issue.
 * 
 * @param id The id of the GitLab Project, the issue belongs to.
 * @param iid The id of the GitLab Issue to close.
 * @param journal The Redmine note text to be added.
 */
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

/**
 * Get the GitLab User ID, if the Redmine Issue is assigned.
 * 
 * @param issue The Redmine Issue details.
 */
const getUserId = (issue) => {
  if (issue.assigned_to) {
    for (let i = 0; i < gitlabUsers.length; i++) {
      if (gitlabUsers[i].name === issue.assigned_to.name) {
        return gitlabUsers[i].id;
      }
    }
  }
};

/**
 * Get the GitLab Milestone ID, if the Redmine Issue is assigned to one.
 * 
 * @param issue The Redmine Issue details.
 */
const getMilestoneId = (issue) => {
  if (issue.fixed_version) {
    for (let i = 0; i < gitlabMilestones.length; i++) {
      //logger.debug('Milestone: ', gitlabMilestones[i].title, ', issue Milestone: ', issue.fixed_version.name);
      if (gitlabMilestones[i].title === issue.fixed_version.name) {
        return gitlabMilestones[i].id;
      }
    }
  }
};

/**
 * Add a reference to a file attachment to the issue.
 * 
 * @param id The id of the GitLab Project, the issue belongs to.
 * @param iid The id of the GitLab Issue to close.
 * @param attachment The Redmine Issue attachement details. 
 */
const addAttachment = (id, iid, attachment) => {
  const attachmentParams = {
    body: `Added File ${attachment.fileData.markdown}`
  };

  gitlabService.post(`/api/v4/projects/${id}/issues/${iid}/notes`,
                     attachmentParams, 
                     gitlabConfig)
    .then(response => {
      logger.info(`Successfully added file to issue: ${iid}`);
    })
    .catch(err => {
      logger.error(`Error adding file to issue ${iid}: `, err);
    });  
};

/**
 * Create a GitLab Issue.
 * 
 * @param id The id of the GitLab Project, the issue belongs to.
 * @param issue: The Redmine Issue details.
 */
const createIssue = (id, issue) => {
  logger.debug('Issue: ', issue);
  const issueParams = {
    id: id,
    title: issue.subject,
    description: issue.description,
    created_at: issue.created_on,
  };

  const userId = getUserId(issue);
  if (userId) {
    logger.debug(`Assigning User ID: ${userId}`);
    issueParams['assignee_ids'] = [userId];
  }

  const milestoneId = getMilestoneId(issue);
  if (milestoneId) {
    logger.debug(`Assigning Milestone ID: ${milestoneId}`);
    issueParams['milestone_id'] = milestoneId;
  }

  logger.debug('Issue Params: ', issueParams);

  gitlabService.post(`/api/v4/projects/${id}/issues`, issueParams, gitlabConfig)
    .then(response => {
      const createIssueResponse = response.data;
      const journals = issue.journals;
      const attachments = issue.attachments;

      // Add notes to issue.
      journals.forEach(journal => {
        if (journal.notes && journal.notes.length > 0) {
          addNote(id, createIssueResponse.iid, journal);
        }
      });

      // Add attachements to issue.
      attachments.forEach(attachment => {
        // Attach a file to the issue.
        // Get corresponding attachment data.
        for (let i = 0; i < gitlabAttachments.length; i++) {
          if (attachment.id === gitlabAttachments[i].id) {
            addAttachment(id, createIssueResponse.iid, gitlabAttachments[i]);
            break;
          }
        }
      });

      // Close issue, if 'closed' or 'rejected'.
      closeIssue(issue.status.name, id, createIssueResponse.iid);
    })
    .catch(err => {
      logger.error(`Error creating issue ${issue.subject}: `,
        err,
        issueParams);
    });
};

/**
 * Upload a file attachement to a Project.
 * 
 * @param project The project to upload the file to.
 * @param attachement Redmine Issue attachment details.
 */
const uploadAttachment = (project, attachment) => {
  const stream = fs.createReadStream(__dirname + '/' + attachment.filename);
  const fd = new FormData();
  fd.append("id", project.id);
  fd.append("file", stream);
  fd.pipe(concat({encoding: 'buffer'}, data => {
    const headers = fd.getHeaders();
    headers['PRIVATE-TOKEN'] = CONFIG.gitlab.key;
    // logger.debug('HEADERS: ', headers);
    axios.post(`https://gitlab-tmp.edina.ac.uk/api/v4/projects/${project.id}/uploads`, data, {
      headers: headers
    })
    .then(response => {
      const fileData = response.data;
      logger.info('Successfully uploaded file: ', fileData);
      gitlabAttachments.push({
        id: attachment.id,
        fileData: fileData
      });
    })
    .catch(err => {
      logger.error('Error uploading file: ', err);
    });
  }));

};

/**
 * Create GitLab Project attachments.
 * 
 * @param project The project to upload file attachments to.
 * @param attachement Redmine Issue attachments.
 */
const createAttachments = (project, attachments) => {
  attachments.forEach(attachment => {
    // GET request for remote image
    // NOTE: This cannot use the throttled instance, that causes ERRCONNRESET errors.
    axios({
      method: 'get',
      url: attachment.content_url,
      responseType: 'stream',
      headers: { 'X-Redmine-API-Key': CONFIG.redmine.key }
    })
      .then(response => {
        // Write file to filesystem.
        response.data.pipe(fs.createWriteStream(attachment.filename));
        uploadAttachment(project, attachment);
      })
      .catch(err => {
        logger.error('Error creating attachment: ', err);
      });
  });
};

/**
 * Create GitLab Project Issues.
 * 
 * @param project The project to create issues for.
 */
const createIssues = (project) => {
  // Create issues in GitLab.
  redmineIssues.forEach(issue => {
    // Get info for each issue, including notes and attachments.
    redmineService.get(`/issues/${issue.id}.json?include=journals,attachments`, redmineConfig)
      .then(response => {
        const issue = response.data.issue;

        const attachments = issue.attachments;
        if (attachments.length > 0) {
          createAttachments(project, attachments);
        }
        createIssue(project.id, issue);
      })
      .catch(err => {
        logger.error('Error getting issue data for: ', err);
      });
  });
};

/**
 * Close a GitLab Project Milestone.
 * 
 * @param project The project the milestone belongs to.
 * @param milestone The milestone to close.
 */
const closeMilestone = (project, milestone) => {
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
    .catch(err => {
      logger.error('Error closing milestone: ', err);
    })
};

/**
 * Create a Gitlab Project Milestone.
 * 
 * @param project The project the milestone belongs to.
 * @param version The Redmine 'Targeted Version' details.
 */
const createMilestone = (project, version) => {
  logger.debug(`Project: ${project.name} - Milestone ${version.name}`);
  const milestoneParams = {
    id: project.id,
    title: version.name,
    description: version.description,
    due_date: version.due_date
  };

  return gitlabService.post(`/api/v4/projects/${project.id}/milestones`, 
                    milestoneParams, 
                    gitlabConfig);
};

/**
 * Get the GitLab Project Milestone associated with the Redmine 'Targeted Version'.
 * 
 * @param version The Redmine 'Targeted Version' details.
 */
const getMilestone = (version) => {
  for (let i = 0; i < gitlabMilestones.length; i++) {
    if (version.name === gitlabMilestones[i].title) {
      return gitlabMilestones[i];
    }
  }
};

/**
 * Create Gitlab Milestones.
 * 
 * @param project The project the milestone belongs to.
 */
const createMilestones = (project) => {
  const projectName = CONFIG.redmine.project.substr(CONFIG.redmine.project.lastIndexOf('/') + 1);
  redmineService.get(`/projects/${projectName}/versions.json`, redmineConfig)
    .then(response => {
      const versions = response.data.versions;
      //logger.debug('Versions: ', versions);

      const milestoneRequests =[];
      // if (versions.length > 0) {
      versions.forEach(version => {
        milestoneRequests.push(createMilestone(project, version));
      });
      // }
      // for (let i = 1; i <= versions.length; i++) {
      //   milestoneRequests.push(createMilestone(project, versions[i]));
      // };

      if (milestoneRequests.length < 1) {
        createIssues(project);
      } else {
        // Create all GitLab Milestones in parallel.
        axios.all([...milestoneRequests])
          .then(axios.spread((...milestones) => {
            milestones.forEach(milestone => {
              gitlabMilestones.push(milestone.data);
            });
            logger.info('Successfully created Gitlab Milestones');

            versions.forEach(version => {
              if (version.status === 'closed') {
                const mile = getMilestone(version);
                closeMilestone(project, mile);
              }
            });
    
            createIssues(project);
          }))
          .catch(error => {
            logger.error(`Error getting milestone data for ${project.name}: `, error);
          });
      }

      // if (versions.length > 0) {
      //   versions.forEach(version => {
      //     createMilestone(project, version);
      //   });
      // }

      // createIssues(project);
    })
    .catch(err => {
      logger.error(`Error getting milestone data for ${project.name}: `, err);
    });
};

/**
 * Get the Redmine Project details.
 */
const getProject = () => {
  const projectName = CONFIG.gitlab.project.substr(CONFIG.gitlab.project.lastIndexOf('/') + 1);
  gitlabService.get(`/api/v4/projects?search=${projectName}&simple=true`,
      gitlabConfig)
    .then(response => {
      const projects = response.data;

      projects.forEach(proj => {
        // Get the project we have specified in config at top of file.
        if (proj.path_with_namespace === CONFIG.gitlab.project) {
          createMilestones(proj);
        }
      }, this);
    })
    .catch(err => {
      logger.error(`Error getting associated Project for ${CONFIG.redmine.project}: `, err);
    });
};

/**
 * Get the Redmine Issues for a page. A page consists of 100 issues, cannot get any more at one time.
 */
const getIssues = (page) => {
  return redmineService.get(`/${CONFIG.redmine.project}/issues.json?limit=100&status_id=*&page=${page}`, redmineConfig);
};

/**
 * Migrate a Redmine Project to GitLab.
 */
const migrate = () => {
  // Get the first 100 users, this is a limitation of the script, but it is
  // difficult to know how many users there are so can't calculate how many
  // pages required.
  gitlabService.get(`/api/v4/users?per_page=100`, gitlabConfig)
    .then(response => {
      gitlabUsers = response.data;

      // Get total number of issues in the project, so we can calculate the number of pages required.
      let page = 1;
      redmineService.get(`/${CONFIG.redmine.project}/issues.json?limit=100&status_id=*&page=${page}`, redmineConfig)
        .then(res => {
          // Calculate how many pages required.
          const total = res.data.total_count;
          const pages = Math.ceil(total / 100);

          // Get an array of function calls.
          const pagedRequests =[];
          for (let i = 1; i <= pages; i++) {
            pagedRequests.push(getIssues(i));
          };

          // Get all Redmine Project Issues in parallel.
          axios.all([...pagedRequests])
          .then(axios.spread((...pages) => {
            for (let i = 0; i < pages.length; i++) {
              redmineIssues = [...redmineIssues, ...pages[i].data.issues];
            }

            getProject();
          }))
          .catch(ex => {
            logger.error(`Error getting all Paged issues for ${CONFIG.redmine.project}: `, ex);
          });
        })
        .catch(error => {
          logger.error(`Error getting issues for ${CONFIG.redmine.project}: `, error);
        });
    })
    .catch(err => {
      logger.error('Error getting list of users from GitLab: ', err);
    });
};

/**
 * Delete all issues in a Gitlab Project.
 * This is really useful during development, shouldn't be used otherwise.
 */
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

/**
 * Get Projects to delete. (The name of this really needs to change).
 */
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

/**
 * Take script argument and call the appropriate function, Display an error if no argument
 * or not recognised.
 */
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
