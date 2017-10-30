# redmine2gitlab

Migrate Redmine issues to a GitHub project.

* [Setup](#setup)
* [Migration Steps](#migration-steps)
* [What does the script do](#what-does-the-script-do)

## Setup

To install dependencies used by the script, run `yarn setup`.

## Migration Steps

1. Edit **index.js**, set the **CONFIG** options to your specific projects.

```json
const CONFIG = {
  redmine: {
    base: '<hostname>',
    project: 'projects/<project name>',
    key: '<Replace with your personal key>'
  },
  gitlab: {
    base: '<hostname>',
    project: '<group>/<project>',
    key: '<Replace with your personal key>'
  }
};
```

2. Run migration script: `yarn start`.

## What does the script do

The first 100 GitLab users are retrieved, this is a limitation of the script as there is no way to calculate how many paged requests are necessary. We could make this configurable I guess, but I didn't need to for my purposes. The 100 limit is the most you can request per page.

Next, we get all the issues for a Redmine Project, in fact a number of parallel paged requests are made and the results concatenated.

The next step is to create GitLab **Milestones**. These are GitLab's version of Redmine's **Targeted Versions**. We get all the versions from Redmine and any existing **Group Milestones** from GitLab.

> NOTE: The script is limited to getting up to 500 milestones from GitLab as there is no way to calculate how many paged requests are necessary.

The script looks for milestones in the project's immediate parent group. If there are no versions, issues are created, otherwise GitLab **Milestones** are created for each version. If the version's **state** is **Closed**, then so to is the milestone closed.

For each Redmine **Issue**, we get the full details, including **notes** and **attachments**. Attachments are downloaded from Redmine and then uploaded to the GitLab project, so it can be referenced in the issues to be created. At this point we have all the information to create issues, the issue details themselves, GitLab Users and Milestones. Each GitLab issue's **Title** is prefixed with **RM#ID**, where **ID** is the Redmine issue id. This is a good idea as notes in issues referencing Redmine Issue IDs, will no longer be correct, this is a workaround for that problem.

Once and Issue has been created, any notes and files attached are then referenced in the issues itself.

Lastly, we check the Issue's state, if it is **Closed** or **Rejected**, then the GitLab issue is closed.
