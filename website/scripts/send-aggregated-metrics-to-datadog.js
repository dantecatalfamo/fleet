module.exports = {


  friendlyName: 'Send aggregated metrics to datadog',


  description: 'Sends the aggregated metrics for usage statistics reported by Fleet instances in the past week',


  fn: async function () {

    sails.log('Running custom shell script... (`sails run send-metrics-to-datadog`)');

    let nowAt = Date.now();
    let oneWeekAgoAt = nowAt - (1000 * 60 * 60 * 24 * 7);
    // get a timestamp in seconds to use for the metrics we'll send to datadog.
    let timestampForTheseMetrics = Math.floor(nowAt / 1000);
    // Get all the usage snapshots for the past week.
    let usageStatisticsReportedInTheLastWeek = await HistoricalUsageSnapshot.find({
      createdAt: { '>=': oneWeekAgoAt},// Search for records created in the past week.
      fleetVersion: {startsWith: '4.'},// Only track metrics for instances reporting 4.x.x versions of Fleet.
    })
    .sort('createdAt DESC');// Sort the results by the createdAt timestamp

    // Filter out development premium licenses and loadtests.
    let filteredStatistics = _.filter(usageStatisticsReportedInTheLastWeek, (report)=>{
      return !_.contains(['Fleet Sandbox', 'fleet-loadtest', 'development only', 'Dev license (expired)', ''], report.organization);
    });

    let statisticsReportedByFleetInstance = _.groupBy(filteredStatistics, 'anonymousIdentifier');

    let metricsToReport = [];
    let latestStatisticsForEachInstance = [];
    for (let id in statisticsReportedByFleetInstance) {
      let lastReportIdForThisInstance = _.max(_.pluck(statisticsReportedByFleetInstance[id], 'id'));
      let latestReportFromThisInstance = _.find(statisticsReportedByFleetInstance[id], {id: lastReportIdForThisInstance});
      latestStatisticsForEachInstance.push(latestReportFromThisInstance);
    }
    let numberOfInstancesToReport = latestStatisticsForEachInstance.length;

    // Get a filtered array of metrics reported by Fleet Premium instances
    let latestPremiumUsageStatistics = _.filter(latestStatisticsForEachInstance, {licenseTier: 'premium'});
    // Group reports by organization name.
    let reportsByOrgName = _.groupBy(latestPremiumUsageStatistics, 'organization');
    for(let org in reportsByOrgName) {
      // Sort the results for this array by the createdAt value. This makes sure we're always sending the most recent results.
      let reportsForThisOrg = _.sortByOrder(reportsByOrgName[org], 'createdAt', 'desc');
      let lastReportForThisOrg = reportsForThisOrg[0];
      // Get the metrics we'll report for each org.
      let lastNumberOfHostsReported = lastReportForThisOrg.numHostsEnrolled;
      let lastReportedFleetVersion = lastReportForThisOrg.fleetVersion;
      let hostCountMetricForThisOrg = {
        metric: 'usage_statistics.num_hosts_enrolled_by_org',
        type: 3,
        points: [{
          timestamp: timestampForTheseMetrics,
          value: lastNumberOfHostsReported
        }],
        resources: [{
          name: reportsByOrgName[org][0].anonymousIdentifier,
          type: 'fleet_instance'
        }],
        tags: [
          `organization:${org}`,
          `fleet_version:${lastReportedFleetVersion}`,
        ],
      };
      metricsToReport.push(hostCountMetricForThisOrg);
    }
    // Build a metric for each Fleet version reported.
    let statisticsByReportedFleetVersion = _.groupBy(latestStatisticsForEachInstance, 'fleetVersion');
    for(let version in statisticsByReportedFleetVersion){
      let numberOfInstancesReportingThisVersion = statisticsByReportedFleetVersion[version].length;
      metricsToReport.push({
        metric: 'usage_statistics.fleet_version',
        type: 3,
        points: [{
          timestamp: timestampForTheseMetrics,
          value: numberOfInstancesReportingThisVersion
        }],
        tags: [`fleet_version:${version}`],
      });
    }
    // Build a metric for each license tier reported.
    let statisticsByReportedFleetLicenseTier = _.groupBy(latestStatisticsForEachInstance, 'licenseTier');
    for(let tier in statisticsByReportedFleetLicenseTier){
      let numberOfInstancesReportingThisLicenseTier = statisticsByReportedFleetLicenseTier[tier].length;
      metricsToReport.push({
        metric: 'usage_statistics.fleet_license',
        type: 3,
        points: [{
          timestamp: timestampForTheseMetrics,
          value: numberOfInstancesReportingThisLicenseTier
        }],
        tags: [`license_tier:${tier}`],
      });
    }
    // Build aggregated metrics for boolean variables:
    // Software Inventory
    let numberOfInstancesWithSoftwareInventoryEnabled = _.where(latestStatisticsForEachInstance, {softwareInventoryEnabled: true}).length;
    let numberOfInstancesWithSoftwareInventoryDisabled = numberOfInstancesToReport - numberOfInstancesWithSoftwareInventoryEnabled;
    metricsToReport.push({
      metric: 'usage_statistics.software_inventory',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithSoftwareInventoryEnabled
      }],
      tags: [`enabled:true`],
    });
    metricsToReport.push({
      metric: 'usage_statistics.software_inventory',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithSoftwareInventoryDisabled
      }],
      tags: [`enabled:false`],
    });
    // vulnDetectionEnabled
    let numberOfInstancesWithVulnDetectionEnabled = _.where(latestStatisticsForEachInstance, {vulnDetectionEnabled: true}).length;
    let numberOfInstancesWithVulnDetectionDisabled = numberOfInstancesToReport - numberOfInstancesWithVulnDetectionEnabled;
    metricsToReport.push({
      metric: 'usage_statistics.vuln_detection',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithVulnDetectionEnabled
      }],
      tags: [`enabled:true`],
    });
    metricsToReport.push({
      metric: 'usage_statistics.vuln_detection',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithVulnDetectionDisabled
      }],
      tags: [`enabled:false`],
    });
    // SystemUsersEnabled
    let numberOfInstancesWithSystemUsersEnabled = _.where(latestStatisticsForEachInstance, {systemUsersEnabled: true}).length;
    let numberOfInstancesWithSystemUsersDisabled = numberOfInstancesToReport - numberOfInstancesWithSystemUsersEnabled;
    metricsToReport.push({
      metric: 'usage_statistics.system_users',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithSystemUsersEnabled
      }],
      tags: [`enabled:true`],
    });
    metricsToReport.push({
      metric: 'usage_statistics.system_users',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithSystemUsersDisabled
      }],
      tags: [`enabled:false`],
    });
    // hostsStatusWebHookEnabled
    let numberOfInstancesWithHostsStatusWebHookEnabled = _.where(latestStatisticsForEachInstance, {hostsStatusWebHookEnabled: true}).length;
    let numberOfInstancesWithHostsStatusWebHookDisabled = numberOfInstancesToReport - numberOfInstancesWithHostsStatusWebHookEnabled;
    metricsToReport.push({
      metric: 'usage_statistics.host_status_webhook',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithHostsStatusWebHookEnabled
      }],
      tags: [`enabled:true`],
    });
    metricsToReport.push({
      metric: 'usage_statistics.host_status_webhook',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithHostsStatusWebHookDisabled
      }],
      tags: [`enabled:false`],
    });
    // mdmMacOsEnabled
    let numberOfInstancesWithMdmMacOsEnabled = _.where(latestStatisticsForEachInstance, {mdmMacOsEnabled: true}).length;
    let numberOfInstancesWithMdmMacOsDisabled = numberOfInstancesToReport - numberOfInstancesWithMdmMacOsEnabled;
    metricsToReport.push({
      metric: 'usage_statistics.macos_mdm',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithMdmMacOsEnabled
      }],
      tags: [`enabled:true`],
    });
    metricsToReport.push({
      metric: 'usage_statistics.macos_mdm',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithMdmMacOsDisabled
      }],
      tags: [`enabled:false`],
    });
    // mdmWindowsEnabled
    let numberOfInstancesWithMdmWindowsEnabled = _.where(latestStatisticsForEachInstance, {mdmWindowsEnabled: true}).length;
    let numberOfInstancesWithMdmWindowsDisabled = numberOfInstancesToReport - numberOfInstancesWithMdmWindowsEnabled;
    metricsToReport.push({
      metric: 'usage_statistics.windows_mdm',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithMdmWindowsEnabled
      }],
      tags: [`enabled:true`],
    });
    metricsToReport.push({
      metric: 'usage_statistics.windows_mdm',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithMdmWindowsDisabled
      }],
      tags: [`enabled:false`],
    });
    // liveQueryDisabled
    let numberOfInstancesWithLiveQueryDisabled = _.where(latestStatisticsForEachInstance, {liveQueryDisabled: true}).length;
    let numberOfInstancesWithLiveQueryEnabled = numberOfInstancesToReport - numberOfInstancesWithLiveQueryDisabled;
    metricsToReport.push({
      metric: 'usage_statistics.live_query',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithLiveQueryDisabled
      }],
      tags: [`enabled:false`],
    });
    metricsToReport.push({
      metric: 'usage_statistics.live_query',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithLiveQueryEnabled
      }],
      tags: [`enabled:true`],
    });
    // hostExpiryEnabled
    let numberOfInstancesWithHostExpiryEnabled = _.where(latestStatisticsForEachInstance, {hostExpiryEnabled: true}).length;
    let numberOfInstancesWithHostExpiryDisabled = numberOfInstancesToReport - numberOfInstancesWithHostExpiryEnabled;
    metricsToReport.push({
      metric: 'usage_statistics.host_expiry',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithHostExpiryEnabled
      }],
      tags: [`enabled:true`],
    });
    metricsToReport.push({
      metric: 'usage_statistics.host_expiry',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: numberOfInstancesWithHostExpiryDisabled
      }],
      tags: [`enabled:false`],
    });

    // Create two metrics to track total number of hosts reported in the last week.
    let totalNumberOfHostsReportedByPremiumInstancesInTheLastWeek = _.sum(_.pluck(_.filter(latestStatisticsForEachInstance, {licenseTier: 'premium'}), 'numHostsEnrolled'));
    metricsToReport.push({
      metric: 'usage_statistics.total_num_hosts_enrolled',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: totalNumberOfHostsReportedByPremiumInstancesInTheLastWeek
      }],
      tags: [`license_tier:premium`],
    });

    let totalNumberOfHostsReportedByFreeInstancesInTheLastWeek = _.sum(_.pluck(_.filter(latestStatisticsForEachInstance, {licenseTier: 'free'}), 'numHostsEnrolled'));
    metricsToReport.push({
      metric: 'usage_statistics.total_num_hosts_enrolled',
      type: 3,
      points: [{
        timestamp: timestampForTheseMetrics,
        value: totalNumberOfHostsReportedByFreeInstancesInTheLastWeek
      }],
      tags: [`license_tier:free`],
    });

    // Break the metrics into smaller arrays to ensure we don't exceed Datadog's 512 kb request body limit.
    let chunkedMetrics = _.chunk(metricsToReport, 500);// Note: 500 stringified JSON metrics is ~410 kb.
    for(let chunkOfMetrics of chunkedMetrics) {
      await sails.helpers.http.post.with({
        url: 'https://api.us5.datadoghq.com/api/v2/series',
        data: {
          series: chunkOfMetrics,
        },
        headers: {
          'DD-API-KEY': sails.config.custom.datadogApiKey,
          'Content-Type': 'application/json',
        }
      }).intercept((err)=>{
        // If there was an error sending metrics to Datadog, we'll log the error in a warning, but we won't throw an error.
        // This way, we'll still return a 200 status to the Fleet instance that sent usage analytics.
        return new Error(`When the send-metrics-to-datadog script sent a request to send metrics to Datadog, an error occured. Raw error: ${require('util').inspect(err)}`);
      });
    }//∞
    sails.log(`Aggregated metrics for ${numberOfInstancesToReport} Fleet instances from the past week sent to Datadog.`);
  }


};

