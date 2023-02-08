import {
  EC2,
  waitUntilInstanceRunning,
  waitUntilInstanceTerminated
} from '@aws-sdk/client-ec2'

import { createWaiter, WaiterState } from '@aws-sdk/util-waiter'

import axios from 'axios'

const PROJECT = 'codelab'

const ec2 = new EC2()

function step(message) {
  process.stdout.write(message)
}

function done() {
  process.stdout.write('✅\n')
}

function tags(type, name) {
  return [{
    ResourceType: type,
    Tags: [{
      Key: 'Project',
      Value: PROJECT
    }, {
      Key: 'Name',
      Value: name
    }]
  }]
}

try {
  const instanceName = `${PROJECT}-instance`
  const secGroupName = `${PROJECT}-security-group`

  const serverPort = 8080
  const proxyHttpPort = 80
  const proxyHttpsPort = 443

  step('Find instances         ')
  const { Reservations } = await ec2.describeInstances({
    Filters: [{
      Name: 'tag:Name',
      Values: [instanceName]
    }]
  })
  done()

  if (Reservations.length > 0) {
    // there should only be at most one instance, but just in case
    const InstanceIds = Reservations.flatMap(({ Instances }) =>
      Instances
        // skip already terminated instances
        .filter(({ State: { Code } }) => Code !== 48)
        .map(({ InstanceId }) => InstanceId)
    )
    if (InstanceIds.length > 0) {
      step('Terminate instances    ')
      await ec2.terminateInstances({ InstanceIds })
      done()

      step('Wait until terminated  ')
      await waitUntilInstanceTerminated(
        { client: ec2 },
        { InstanceIds }
      )
      done()
    }
  }

  step('Delete security group  ')
  await ec2.deleteSecurityGroup({ GroupName: secGroupName })
  done()

  step('Create security group  ')
  const { GroupId } = await ec2.createSecurityGroup({
    TagSpecifications: tags('security-group', secGroupName),
    GroupName: secGroupName,
    Description: secGroupName
  })
  done()

  step('Allow ingress HTTP     ')
  await ec2.authorizeSecurityGroupIngress({
    GroupId,
    IpProtocol: 'tcp',
    CidrIp: '0.0.0.0/0',
    FromPort: proxyHttpPort,
    ToPort: proxyHttpPort
  })
  done()

  step('Allow ingress HTTPS    ')
  await ec2.authorizeSecurityGroupIngress({
    GroupId,
    IpProtocol: 'tcp',
    CidrIp: '0.0.0.0/0',
    FromPort: proxyHttpsPort,
    ToPort: proxyHttpsPort
  })
  done()

  step('Run instance           ')
  const { Instances: [{ InstanceId }] } = await ec2.runInstances({
    TagSpecifications: tags('instance', instanceName),
    MinCount: 1,
    MaxCount: 1,
    InstanceType: 't2.nano',
    // Amazon Linux 2 Kernel 5.10
    ImageId: 'ami-06e85d4c3149db26a',
    SecurityGroupIds: [GroupId],
    UserData: btoa([
      '#cloud-config',
      'packages:',
      ' - git',
      ' - docker',
      'runcmd:',
      ' - [sh, -c, "',
      [
        'systemctl start docker',
        `curl --create-dirs --output /usr/share/codelab/install-code-server.sh --location https://code-server.dev/install.sh`,
        `chmod u+x /usr/share/codelab/install-code-server.sh`,
        `git clone https://github.com/microsoft/vscode-remote-try-node.git /srv/workspace`,
        `docker network create ${PROJECT}-net`,
        `docker run --detach --name code-server --net ${PROJECT}-net`
          + ` --volume /usr/share/codelab:/mnt/codelab --volume /srv:/srv buildpack-deps`
          + ' sh -c \\"' + [
            '/mnt/codelab/install-code-server.sh',
            `code-server --auth none --bind-addr 0.0.0.0:${serverPort} /srv/workspace`
          ].join(' && ') + '\\"',
        'DIG_OUT=$(dig +short -x $(dig +short @resolver4.opendns.com myip.opendns.com))',
        `docker run --detach --name caddy --net ${PROJECT}-net`
          + ` --publish ${proxyHttpPort}:${proxyHttpPort} --publish ${proxyHttpsPort}:${proxyHttpsPort} caddy`
          + ` caddy reverse-proxy --from \${DIG_OUT::-1}:${proxyHttpsPort} --to code-server:${serverPort}`,
      ].join(' && '),
      '  "]'
    ].join('\n'))
  })
  done()

  step('Wait until running     ')
  await waitUntilInstanceRunning(
    { client: ec2 },
    { InstanceIds: [InstanceId] }
  )
  done()

  step('Get DNS name           ')
  const { Reservations: [{
    Instances: [{ PublicDnsName }]
  }] } = await ec2.describeInstances({
    InstanceIds: [InstanceId]
  })
  done()

  let publicUrl = `https://${PublicDnsName}`

  step('Wait until ready       ')
  await createWaiter({ maxDelay: 2 }, null, async () => {
    try {
      let { status } = await axios.get(`${publicUrl}/healthz`)
      return { state: status === 200 ? WaiterState.SUCCESS : WaiterState.FAILURE }
    } catch {
      return { state: WaiterState.RETRY }
    }
  })
  done()

  console.log(publicUrl)
} catch (error) {
  console.error(error)
}