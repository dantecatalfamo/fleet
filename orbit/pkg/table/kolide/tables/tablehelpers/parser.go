package tablehelpers

import (
	"bufio"
	"bytes"

	"github.com/go-kit/kit/log"
	"github.com/go-kit/kit/log/level"
)

type Matcher struct {
	Match   func(string) bool
	KeyFunc func(string) (string, error)
	ValFunc func(string) (string, error)
}

type OutputParser struct {
	matchers []Matcher
	logger   log.Logger
}

func NewParser(logger log.Logger, matchers []Matcher) *OutputParser {
	p := &OutputParser{
		matchers: matchers,
		logger:   logger,
	}
	return p
}

// Parse looks at a chunk of input. It is assumed that the input contains
// information to fill in a single result. Do not provide input that contains
// data for multiple results.
func (p *OutputParser) Parse(input *bytes.Buffer) map[string]string {
	row := make(map[string]string)
	scanner := bufio.NewScanner(input)
	scanner.Split(bufio.ScanLines)

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		for _, m := range p.matchers {
			if m.Match(line) {
				key, err := m.KeyFunc(line)
				if err != nil {
					level.Debug(p.logger).Log(
						"msg", "key match failed",
						"line", line,
						"err", err,
					)
					continue
				}

				val, err := m.ValFunc(line)
				if err != nil {
					level.Debug(p.logger).Log(
						"msg", "value match failed",
						"line", line,
						"err", err,
					)
					continue
				}

				row[key] = val
				continue
			}
		}
	}
	return row
}

// Parse looks at command output, line by line. It uses the defined Matchers to set any appropriate values
func (p *OutputParser) ParseMultiple(input *bytes.Buffer) []map[string]string {
	var results []map[string]string

	scanner := bufio.NewScanner(input)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		row := make(map[string]string)

		// check each possible key match
		for _, m := range p.matchers {
			if m.Match(line) {
				key, err := m.KeyFunc(line)
				if err != nil {
					level.Debug(p.logger).Log(
						"msg", "key match failed",
						"line", line,
						"err", err,
					)
					continue
				}

				val, err := m.ValFunc(line)
				if err != nil {
					level.Debug(p.logger).Log(
						"msg", "value match failed",
						"line", line,
						"err", err,
					)
					continue
				}

				row[key] = val
				continue
			}
		}

		if len(row) == 0 {
			level.Debug(p.logger).Log("msg", "No matched keys", "line", line)
			continue
		}
		results = append(results, row)

	}
	if err := scanner.Err(); err != nil {
		level.Debug(p.logger).Log("msg", "scanner error", "err", err)
	}
	return results
}
