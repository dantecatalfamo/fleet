// package update contains the types and functions used by the update system.
package update

import (
	"crypto/tls"
	"encoding/json"
	"io/ioutil"
	"net/http"
	"os"
	"path"
	"path/filepath"

	"github.com/fleetdm/orbit/pkg/constant"
	"github.com/pkg/errors"
	"github.com/rs/zerolog/log"
	"github.com/theupdateframework/go-tuf/client"
	"github.com/theupdateframework/go-tuf/data"
)

const (
	binDir = "bin"

	defaultRootKeys = `[{"keytype":"ed25519","scheme":"ed25519","keyid_hash_algorithms":["sha256","sha512"],"keyval":{"public":"c5008789635b7ac63228d80eec24edbfb8b3bddfd2121b08456de201ec24df7a"}}]`
)

// Updater is responsible for managing update state.
type Updater struct {
	opt    Options
	client *client.Client
}

// Options are the options that can be provided when creating an Updater.
type Options struct {
	// RootDirectory is the root directory from which other directories should be referenced.
	RootDirectory string
	// ServerURL is the URL of the update server.
	ServerURL string
	// InsecureTransport skips TLS certificate verification in the transport if
	// set to true. Best to leave this on, but due to the file signing any
	// tampering by a MitM should be detectable.
	InsecureTransport bool
	// RootKeys is the JSON encoded root keys to use to bootstrap trust.
	RootKeys string
	// LocalStore is the local metadata store.
	LocalStore client.LocalStore
	// Platform is the name of the platform to update for. In the default
	// options this is the current platform.
	Platform string
}

var (
	// DefaultOptions are the default options to use when creating an update
	// client.
	DefaultOptions = Options{
		RootDirectory:     "/var/fleet",
		ServerURL:         "https://tuf.fleetctl.com",
		LocalStore:        client.MemoryLocalStore(),
		InsecureTransport: false,
		Platform:          constant.PlatformName,
		RootKeys:          defaultRootKeys,
	}
)

// New creates a new updater given the provided options. All the necessary
// directories are initialized.
func New(opt Options) (*Updater, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{
		InsecureSkipVerify: opt.InsecureTransport,
	}
	httpClient := &http.Client{Transport: transport}

	remoteStore, err := client.HTTPRemoteStore(opt.ServerURL, nil, httpClient)
	if err != nil {
		return nil, errors.Wrap(err, "init remote store")
	}

	tufClient := client.NewClient(opt.LocalStore, remoteStore)
	var rootKeys []*data.Key
	if err := json.Unmarshal([]byte(opt.RootKeys), &rootKeys); err != nil {
		return nil, errors.Wrap(err, "unmarshal root keys")
	}

	meta, err := opt.LocalStore.GetMeta()
	if err != nil || meta["root.json"] == nil {
		var rootKeys []*data.Key
		if err := json.Unmarshal([]byte(opt.RootKeys), &rootKeys); err != nil {
			return nil, errors.Wrap(err, "unmarshal root keys")
		}
		if err := tufClient.Init(rootKeys, 1); err != nil {
			return nil, errors.Wrap(err, "init tuf client")
		}
	}

	updater := &Updater{
		opt:    opt,
		client: tufClient,
	}

	if err := updater.initializeDirectories(); err != nil {
		return nil, err
	}

	return updater, nil
}

func (u *Updater) UpdateMetadata() error {
	if _, err := u.client.Update(); err != nil {
		// An error is returned if we are already up-to-date. We can ignore that
		// error.
		if !client.IsLatestSnapshot(errors.Cause(err)) {
			return errors.Wrap(err, "update metadata")
		}
	}
	return nil
}

func (u *Updater) RepoPath(name, version string) string {
	return path.Join(name, u.opt.Platform, version, name+constant.ExecutableExtension(u.opt.Platform))
}

func (u *Updater) LocalPath(name, version string) string {
	return u.pathFromRoot(filepath.Join(binDir, name, u.opt.Platform, version, name+constant.ExecutableExtension(u.opt.Platform)))
}

// Lookup looks up the provided target in the local target metadata. This should
// be called after UpdateMetadata.
func (u *Updater) Lookup(name, version string) (*data.TargetFileMeta, error) {
	target, err := u.client.Target(u.RepoPath(name, version))
	if err != nil {
		return nil, errors.Wrapf(err, "lookup target %v", target)
	}

	return &target, nil
}

// Targets gets all of the known targets
func (u *Updater) Targets() (data.TargetFiles, error) {
	targets, err := u.client.Targets()
	if err != nil {
		return nil, errors.Wrapf(err, "get targets")
	}

	return targets, nil
}

// Get returns the local path to the specified target. The target is downloaded
// if it does not yet exist locally or the hash does not match.
func (u *Updater) Get(name, version string) (string, error) {
	localPath := u.LocalPath(name, version)
	repoPath := u.RepoPath(name, version)
	stat, err := os.Stat(localPath)
	if err != nil {
		log.Debug().Err(err).Msg("stat file")
		return localPath, u.Download(repoPath, localPath)
	}
	if !stat.Mode().IsRegular() {
		return "", errors.Errorf("expected %s to be regular file", localPath)
	}

	meta, err := u.Lookup(name, version)
	if err != nil {
		return "", err
	}

	if err := CheckFileHash(meta, localPath); err != nil {
		log.Debug().Err(err).Msg("will redownload due to error checking hash")
		return localPath, u.Download(repoPath, localPath)
	}

	log.Debug().Str("path", localPath).Msg("found expected version locally")

	return localPath, nil
}

// Download downloads the target to the provided path. The file is deleted and
// an error is returned if the hash does not match.
func (u *Updater) Download(repoPath, localPath string) error {
	tmp, err := ioutil.TempFile("", "orbit-download")
	if err != nil {
		return errors.Wrap(err, "open temp file for download")
	}
	defer func() {
		tmp.Close()
		os.Remove(tmp.Name())
	}()

	if err := os.MkdirAll(filepath.Dir(localPath), constant.DefaultDirMode); err != nil {
		return errors.Wrap(err, "initialize download dir")
	}

	if err := u.client.Download(repoPath, &fileDestination{tmp}); err != nil {
		return errors.Wrapf(err, "download target %s", repoPath)
	}

	if err := os.Chmod(tmp.Name(), constant.DefaultExecutableMode); err != nil {
		return errors.Wrap(err, "chmod download")
	}

	if err := os.Rename(tmp.Name(), localPath); err != nil {
		return errors.Wrap(err, "move download")
	}

	return nil
}

func (u *Updater) pathFromRoot(parts ...string) string {
	return filepath.Join(append([]string{u.opt.RootDirectory}, parts...)...)
}

func (u *Updater) initializeDirectories() error {
	for _, dir := range []string{
		u.pathFromRoot(binDir),
	} {
		err := os.MkdirAll(dir, constant.DefaultDirMode)
		if err != nil {
			return errors.Wrap(err, "initialize directories")
		}
	}

	return nil
}
