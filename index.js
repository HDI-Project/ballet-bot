const travis = require('./lib/travis.js')
const github = require('./lib/github.js')
const prune = require('./lib/pruning.js')
const util = require('util')

const BALLET_CONFIG_FILE = 'ballet.yml'

/**
 * This is the main entrypoint to your Probot app
 * @param {import('probot').Application} app
 */
module.exports = app => {
  app.on('check_run.completed', async context => {
    context.log(`Responding to ${context.event} (id=${context.id})`)

    const repoUrl = context.payload.repository.html_url
    const detailsUrl = context.payload.check_run.details_url

    const repoDir = await github.downloadRepo(repoUrl)
    const config = await loadConfig(context)

    const travisBuildId = travis.getBuildIdFromDetailsUrl(detailsUrl)
    const travisBuild = await travis.getBuildFromId(travisBuildId)

    logImportantInformation(context, travisBuild)

    const shouldPrune = shouldPruneRedundantFeatures(context, config, travisBuildId)
    const shouldMerge = shouldMergeAcceptedFeature(context, config, travisBuild)
    const shouldClose = shouldCloseRejectedFeature(context, config, travisBuild)

    if (await shouldPrune) {
      await pruneRedundantFeatures(context, repoDir.name, config, travisBuild)
    }

    if (await shouldMerge) {
      await github.mergePullRequest(context, travisBuild.pull_request_number)
      await github.closePullRequest(context, travisBuild.pull_request_number)
    }

    if (await shouldClose) {
      await github.closePullRequest(context, travisBuild.pull_request_number)
    }

    repoDir.removeCallback()
  })
}

const loadConfig = async (context) => {
  const config = await context.config(`../${BALLET_CONFIG_FILE}`)
  if (config.default) {
    const s = util.inspect(config.default, { depth: 5, breakLength: Infinity })
    context.log.debug(`Loaded config from ballet.yml:default: ${s}`)
    return config.default
  }
}

const logImportantInformation = (context, travisBuild) => {
  context.log(`Getting a check from branch: ${travisBuild.branch.name}`)
  context.log(`On commit: ${travisBuild.commit.message}`)
}

const shouldMergeAcceptedFeature = async (context, config, build) => {
  if (build.event_type !== 'pull_request') {
    context.log('Not merging because not a pull request')
    return false
  } else if (!(await travis.doesBuildPassAllChecks(build.id))) {
    context.log('Not merging because not passing')
    return false
  } else if (
    !(await github.isPullRequestProposingFeature(
      context,
      build.pull_request_number
    ))
  ) {
    context.log('Not merging because not proposing a feature')
    return false
  } else if (config.github.auto_merge_accepted_features === 'no') {
    context.log('Not merging because config')
    return false
  }
  return true
}

const shouldPruneRedundantFeatures = async (context, config, buildId) => {
  if (!(await github.isOnMasterAfterMerge(context))) {
    context.log('Not pruning because not on master on merge')
    return false
  } else if (!(await travis.doesBuildPassAllChecks(buildId))) {
    context.log('Not pruning because Travis is failing')
    return false
  } else if (config.github.pruning_action === 'no_action') {
    context.log('Not pruning because config')
    return false
  }

  return true
}

const pruneRedundantFeatures = async (context, repoDir, config, build) => {
  const redundantFeatures = await travis.getTravisRedundantFeatures(build)
  context.log('FOUND REDUNDANT FEATURES: ')
  context.log(redundantFeatures.join('\n'))
  if (redundantFeatures.length) {
    return prune.removeRedundantFeatures(
      context,
      repoDir,
      config,
      redundantFeatures
    )
  }
}

const shouldCloseRejectedFeature = async (context, config, build) => {
  if (build.event_type !== 'pull_request') {
    context.log('Not closing because not a pull request')
    return false
  } else if (await travis.doesBuildPassAllChecks(build.id)) {
    context.log('Not closing because passed all checks')
    return false
  } else if (
    !(await github.isPullRequestProposingFeature(
      context,
      build.pull_request_number
    ))
  ) {
    context.log('Not closing because not proposing a feature')
    return false
  } else if (config.github.auto_close_rejected_features === 'no') {
    context.log('Not closing because config')
    return false
  }
  return true
}
